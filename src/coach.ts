// Access module for the coach-agent edge function (mirrors src/races.ts /
// src/routes.ts: direct calls, not the db blob). The function reads the plan
// and run history from app_state server-side, so we flush the debounced blob
// first — otherwise the coach could reason over a stale plan.

import { supabase } from "./supabase";
import { flushNow } from "./db";
import { FunctionsHttpError, FunctionsFetchError, FunctionsRelayError } from "@supabase/supabase-js";
import { t } from "./i18n";
import { track } from "./telemetry";
import type { Plan } from "./types";
import type { CoachUsage } from "./utils/coachUsage";

// A server-carried application error (rate limit, closed trajectory, …). Unlike
// a bare Error it preserves the stable `code` (so callers can react to
// TRAJECTORY_CLOSED etc.) and any `usage` the server attached (so the ring can
// update even on a RATE_LIMIT rejection). `message` is already localized.
export class CoachServerError extends Error {
  code?: string;
  usage?: CoachUsage;
  constructor(message: string, code?: unknown, usage?: unknown) {
    super(message);
    this.name = "CoachServerError";
    if (typeof code === "string") this.code = code;
    this.usage = coerceUsage(usage);
  }
}

// Accept a server `usage` payload only when both fields are finite numbers;
// anything else (old function, malformed) becomes undefined so the ring hides.
function coerceUsage(value: unknown): CoachUsage | undefined {
  if (value && typeof value === "object") {
    const { used, limit } = value as { used?: unknown; limit?: unknown };
    if (typeof used === "number" && Number.isFinite(used) && typeof limit === "number" && Number.isFinite(limit)) {
      return { used, limit };
    }
  }
  return undefined;
}

// Longer than normal Supabase calls because a cold coach-agent boot may need to
// start Deno and import the Anthropic SDK before it can send response headers.
const COACH_INVOKE_TIMEOUT_MS = 60000;

// Delivery recovery: production request logs showed the dominant coach failure
// is the round SUCCEEDING server-side while the streamed response dies before
// the body reaches the phone (a truncated 200 → raw JSON parse error → generic
// "unavailable" bubble). Every propose/critique therefore carries a
// client-generated requestId that the server stamps onto the logged round
// together with the exact response body; when the invoke fails at the
// transport level we poll the no-model `result` action for that id instead of
// surfacing an error — the finished proposal is delivered on the second, warm,
// fast connection and the model call is never re-run (no double token spend,
// no double rate-limit charge). `found: false` means the round is still
// running (or never started), so we poll across the window a slow round needs.
const RESULT_POLL_INTERVAL_MS = 3000;
const RESULT_POLL_MAX_ATTEMPTS = 15;
// If the polls THEMSELVES keep failing at the transport level the device is
// genuinely offline — bail out early rather than spinning for the full window.
const RESULT_POLL_MAX_TRANSPORT_FAILURES = 3;
const RESULT_POLL_TIMEOUT_MS = 10000;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// Maps a functions.invoke() *transport* failure to a user-facing message.
// App-level failures (rate limit, etc.) reply 200 with `data.error` instead —
// this only fires for genuine transport problems (offline, relay down, edge
// platform 401/5xx); see recoverRound() below for the truncated-body case.
type CoachAction =
  | { action: "ping" }
  | { action: "propose"; message: string }
  | { action: "critique"; trajectoryId: string; message: string }
  | { action: "confirm"; trajectoryId: string };

export type CoachResponse = {
  error?: string;
  plan?: Plan;
  trajectoryId?: string;
  roundIndex?: number;
  text?: string;
  usage?: CoachUsage;
  [key: string]: unknown;
};

function transportMessage(error: unknown) {
  if (error instanceof FunctionsFetchError) {
    // Fetch never completed — only true network drops say "offline"; a
    // client-side timeout/abort points at cold start / retry instead.
    const reason = error.context as { name?: string } | undefined;
    if (reason?.name === "TimeoutError" || reason?.name === "AbortError") {
      return t("coach.errors.transport.timeout");
    }
    return t("coach.errors.transport.offline");
  }
  if (error instanceof FunctionsRelayError) {
    return t("coach.errors.transport.timeout"); // retry usually lands on a warm isolate
  }
  if (error instanceof FunctionsHttpError) {
    const status = error.context?.status;
    if (status === 401 || status === 403) return t("coach.errors.transport.reauth"); // expired JWT
    return t("coach.errors.transport.timeout"); // boot ran long / timed out
  }
  return t("coach.errors.transport.unavailable");
}

// Localize a server-carried app error via its stable `code`, falling back to the
// server's English `error` text for any code we don't have a translation for
// (old clients / new codes stay readable rather than blank).
function serverMessage(data: { error?: string; code?: unknown }) {
  const fallback = data.error ?? t("coach.errors.transport.unavailable");
  return typeof data.code === "string"
    ? t(`coach.errors.server.${data.code}`, { defaultValue: fallback })
    : fallback;
}

// Poll the `result` action for a round whose response never arrived. Resolves
// with the recovered response, throws for a server-carried error (a real
// answer — surface it), or resolves null when recovery is exhausted (caller
// falls back to the original transport error message).
async function recoverRound(requestId: string): Promise<CoachResponse | null> {
  let transportFailures = 0;
  for (let attempt = 0; attempt < RESULT_POLL_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RESULT_POLL_INTERVAL_MS);
    const { data, error } = await supabase.functions.invoke("coach-agent", {
      body: { action: "result", requestId },
      timeout: RESULT_POLL_TIMEOUT_MS,
    });
    if (error) {
      if (++transportFailures >= RESULT_POLL_MAX_TRANSPORT_FAILURES) return null;
      continue;
    }
    transportFailures = 0;
    if (data?.error) throw new CoachServerError(serverMessage(data), data.code, data.usage);
    if (data?.found) {
      track("coach_round_recovered", { attempts: attempt + 1 });
      const recovered = { ...data } as CoachResponse & { found?: boolean };
      delete recovered.found;
      return recovered;
    }
    // found: false — round still running (or never logged); keep polling.
  }
  return null;
}

async function invoke(body: CoachAction): Promise<CoachResponse> {
  // confirm reads from agent_rounds (not app_state), so no flush needed —
  // and a flush failure must not block confirming an already-proposed plan.
  if (body.action !== "confirm") await flushNow();
  const requestId = body.action === "confirm" ? null : crypto.randomUUID();
  const { data, error } = await supabase.functions.invoke("coach-agent", {
    body: requestId ? { ...body, requestId } : body,
    timeout: COACH_INVOKE_TIMEOUT_MS,
  });
  if (error) {
    // Transport failure — but the round may have completed server-side.
    // Try to fetch the finished result before showing an error; only give
    // up if recovery is exhausted too.
    if (requestId) {
      const recovered = await recoverRound(requestId);
      if (recovered) return recovered;
    }
    throw new Error(transportMessage(error));
  }
  if (data?.error) throw new CoachServerError(serverMessage(data), data.code, data.usage);
  return data;
}

// Fire-and-forget cold-start warmer. The coach-agent `ping` action returns
// before any auth/DB/model work, so this just pays the isolate boot + module
// import cost early (called when the chat opens) — the first real round then
// lands on a warm isolate. Best effort by design: it swallows every error and
// never blocks the UI. If it fails, the first round simply pays the cold start
// as it did before.
export async function coachPing() {
  try {
    await supabase.functions.invoke("coach-agent", {
      body: { action: "ping" },
      timeout: COACH_INVOKE_TIMEOUT_MS,
    });
  } catch {
    // warming is an optimization, not a requirement — ignore all failures.
  }
}

// Read today's coach spend vs the daily budget for the usage ring. Deliberately
// NOT routed through invoke(): that flushes the app_state blob and, on a
// transport failure, polls the `result` action for ~45s with a requestId this
// read never stamps — all wrong for a cheap counter read. Best-effort: any
// failure (offline, or an OLD deployed function that rejects the `usage`
// action) resolves to null, and the caller simply hides the ring.
export async function coachUsage(): Promise<CoachUsage | null> {
  try {
    const { data, error } = await supabase.functions.invoke("coach-agent", {
      body: { action: "usage" },
      timeout: COACH_INVOKE_TIMEOUT_MS,
    });
    if (error || !data || data.error) return null;
    return coerceUsage(data) ?? null;
  } catch {
    return null;
  }
}

export const coachPropose = (message: string) => invoke({ action: "propose", message });
export const coachCritique = (trajectoryId: string, message: string) => invoke({ action: "critique", trajectoryId, message });
export const coachConfirm = (trajectoryId: string) => invoke({ action: "confirm", trajectoryId });
