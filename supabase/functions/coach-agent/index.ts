// coach-agent — the AI adjustment coach. Propose-and-confirm: the model may
// only EDIT the existing training plan through a bounded tool vocabulary
// (_shared/coach/tools.mjs); every proposal passes the shared validator
// (_shared/coach/validation.mjs) before the user sees it; the user accepts or
// steers with natural-language feedback. No auto-apply.
//
// Trust boundary: the API key, the validator, the tool implementations, the
// rate limit and the audit log all live here, server-side. The client sends a
// message and renders the returned proposal.
//
// Two-client split (privilege separation):
//   * userClient (anon key + caller's JWT): auth check + reading the caller's
//     app_state blob — RLS applies.
//   * admin (service role): agent_trajectories / agent_rounds / agent_usage —
//     tables the user has NO write access to (tamper-proof audit log).
// Committing an accepted plan is NOT done server-side: the client owns an
// in-memory copy of the whole app_state blob and debounce-upserts it, so a
// server write would be clobbered within seconds. `confirm` re-validates and
// returns the plan; the client persists it through its normal RLS-guarded path.
//
// Actions (POST { action, message?, trajectoryId?, requestId? }):
//   propose  — new trajectory from a runner message → validated proposal
//   critique — steer an open trajectory with feedback → new validated proposal
//   confirm  — NO model call; re-validate + mark accepted, return the plan
//   result   — NO model call; replay the stored response of the round stamped
//              with requestId (delivery recovery after a dropped stream)
//
// Deploy:  supabase functions deploy coach-agent
// Secrets: supabase secrets set ANTHROPIC_API_KEY=...
//   Optional: COACH_MODEL (default claude-sonnet-5), COACH_MODEL_LIGHT
//   (routing seam, default claude-haiku-4-5), RATE_LIMIT_PER_DAY (default 5;
//   premium accounts get PREMIUM_RATE_LIMIT_PER_DAY, default 40, and a per-user
//   override lives in profiles.coach_daily_limit),
//   MOCK_LLM=1 (canned responses, zero Anthropic calls — CI / local dev).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";
import { generateProposal, SYSTEM_PROMPT } from "../_shared/coach/engine.mjs";
import { validatePlan, formatValidation } from "../_shared/coach/validation.mjs";
import { createMockModel } from "../_shared/coach/mock.mjs";
import { buildRunDigest } from "../_shared/coach/runDigest.mjs";

const MOCK = Boolean(Deno.env.get("MOCK_LLM"));
const DEFAULT_MODEL = Deno.env.get("COACH_MODEL") ?? "claude-sonnet-5";
const LIGHT_MODEL = Deno.env.get("COACH_MODEL_LIGHT") ?? "claude-haiku-4-5";
const RATE_LIMIT_PER_DAY = Number(Deno.env.get("RATE_LIMIT_PER_DAY") ?? 5);
// Premium accounts get a much larger daily coach budget. This RAISES the free
// allowance for paying users; it never lowers anyone's — the free default stays
// exactly where it was, which is the standing rule in docs/monetization.md (the
// limit is cost-insurance, never a lever to force upgrades).
const PREMIUM_RATE_LIMIT_PER_DAY = Number(Deno.env.get("PREMIUM_RATE_LIMIT_PER_DAY") ?? 40);
// The Anthropic SDK retries transient failures (429, 5xx incl. 529 overloaded,
// and connection errors) with exponential backoff on its own. We set these
// explicitly rather than leaning on the library default (maxRetries: 2) so a
// momentarily overloaded model doesn't sink a whole coaching round on the first
// blip, and so each attempt is bounded — one hung call can't stall the round
// forever. The keep-alive stream (below) keeps the HTTP connection itself alive
// while these retries happen, so the client never sees the churn.
const MODEL_MAX_RETRIES = Number(Deno.env.get("COACH_MODEL_MAX_RETRIES") ?? 4);
const MODEL_TIMEOUT_MS = Number(Deno.env.get("COACH_MODEL_TIMEOUT_MS") ?? 60000);
// A propose/critique round spends most of its time awaiting Anthropic with
// zero bytes flowing to the client — long enough for some intermediary
// (mobile network, proxy) to treat the connection as dead and drop it well
// before either side's own timeout fires, even though the round completes
// successfully server-side. Deno.serve below sends a whitespace byte
// immediately (flushing headers + first byte at t=0) and then on this
// interval while a round is in flight so the connection never looks idle;
// JSON.parse ignores leading whitespace, so the eventual real body still
// parses cleanly. Production request logs showed connections already dead at
// the FIRST write with the old 5s interval, so the padding starts at 0 and
// stays tight.
const KEEPALIVE_INTERVAL_MS = 2000;
const USER_CONTEXT_MAX_CHARS = 2000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Routing seam (Phase 5): everything is judgment-heavy coaching for v1, so
// always the default model. To route trivial edits to LIGHT_MODEL later, add a
// classifier here — nothing else changes.
function pickModel(_message: string): string {
  return DEFAULT_MODEL;
}

function cleanUserContext(value: unknown): { notes: string } {
  const notes = typeof value === "object" && value && "notes" in value
    ? String((value as { notes?: unknown }).notes ?? "")
    : "";
  return { notes: notes.replace(/\r\n?/g, "\n").slice(0, USER_CONTEXT_MAX_CHARS) };
}

// The caller's effective daily coach budget, most specific first:
//   1. profiles.coach_daily_limit — an explicit per-user override, still the
//      final word (it's how a single account gets a bespoke budget).
//   2. premium (profiles.premium_until in the future) — PREMIUM_RATE_LIMIT_PER_DAY.
//   3. the env default.
// Both columns are service-role-writable only, so neither can be self-granted;
// read via the admin client, which bypasses RLS on profiles.
//
// A failed read THROWS (caller turns it into COACH_UNAVAILABLE) rather than
// silently falling back to the free number — a paying user should see an error,
// not a quietly smaller allowance.
// deno-lint-ignore no-explicit-any
async function getDailyLimit(admin: any, userId: string): Promise<number> {
  const { data, error } = await admin.from("profiles")
    .select("coach_daily_limit, premium_until").eq("id", userId).maybeSingle();
  if (error) throw error;
  const n = Number(data?.coach_daily_limit);
  if (Number.isFinite(n) && n > 0) return n;
  // NaN (including the banned 'infinity' literal) reads as not-premium, exactly
  // as isPremiumActive does on the client.
  const until = data?.premium_until ? Date.parse(String(data.premium_until)) : NaN;
  if (Number.isFinite(until) && until > Date.now()) return PREMIUM_RATE_LIMIT_PER_DAY;
  return RATE_LIMIT_PER_DAY;
}

// deno-lint-ignore no-explicit-any
function makeCallModel(context: any, message: string) {
  if (MOCK) return { model: "mock", callModel: createMockModel(context) };
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured (set it, or MOCK_LLM=1)");
  const client = new Anthropic({ apiKey, maxRetries: MODEL_MAX_RETRIES, timeout: MODEL_TIMEOUT_MS });
  const model = pickModel(message);
  // deno-lint-ignore no-explicit-any
  const callModel = (messages: any[], tools: any[]) =>
    client.messages.create({
      model,
      max_tokens: 4096,
      // Tools render before system, so one breakpoint on the system block
      // caches the whole stable prefix (tool defs + system prompt).
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    });
  return { model, callModel };
}

// Runs the whole action and resolves to the JSON body that should be sent to
// the client. HTTP status is intentionally NOT decided here — Deno.serve
// below streams keep-alive padding before the outcome is known, so headers
// (always 200) go out long before this resolves. Success/failure is carried
// entirely in the body's shape (an `.error` field on failure); `src/coach.ts`
// already treats `data.error` and a non-2xx response identically, so this is
// not a client-visible behaviour change.
// deno-lint-ignore no-explicit-any
async function handle(req: Request): Promise<any> {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  // Cold-start warmer: the client fires this when the coach chat opens so the
  // isolate is booted and the npm:@anthropic-ai/sdk module graph is imported by
  // the time a real propose/critique arrives. Returns before any auth, DB read
  // or model call — its only job is to pay the isolate boot cost early. The
  // top-level imports (which dominate cold-boot) run on any request regardless.
  if (action === "ping") return { ok: true };
  if (!["propose", "critique", "confirm", "result", "usage"].includes(action)) {
    return { error: "action must be propose | critique | confirm | result | usage" };
  }
  // Client-generated delivery id for propose/critique. If the streamed
  // response never reaches the client (the dominant production failure — the
  // round succeeds but the connection dies mid-stream), the client re-fetches
  // the finished round via `result` with the same id instead of re-running
  // the model. Must be a real UUID (the column is typed uuid); anything else
  // degrades to "no recovery" rather than failing the round.
  const requestId = typeof body.requestId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.requestId)
    ? body.requestId
    : null;

  // ── auth: a valid JWT is required for everything ─────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return { error: "unauthorized" };
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: auth } = await userClient.auth.getUser();
  const user = auth?.user;
  if (!user) return { error: "unauthorized" };

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── usage: report today's spend vs the caller's daily budget ─────────────
  // No model call, no charge — a plain read of the atomic counter (agent_usage
  // has no client RLS policy, so this must go through the admin client, not a
  // direct client query). `used` is clamped to `limit` for display because the
  // counter keeps incrementing past the cap on rejected attempts (charge-then-
  // check). Drives the chat's usage ring; entirely optional to the client.
  if (action === "usage") {
    const day = new Date().toISOString().slice(0, 10);
    const [usageRes, limit] = await Promise.all([
      admin.from("agent_usage").select("count").eq("user_id", user.id).eq("day", day).maybeSingle(),
      getDailyLimit(admin, user.id),
    ]);
    if (usageRes.error) throw usageRes.error;
    return { used: Math.min(usageRes.data?.count ?? 0, limit), limit };
  }

  // ── result: recover an already-completed round — no model call, no charge ─
  // Replays the exact stored response body of the round stamped with this
  // requestId, after re-checking the trajectory belongs to the caller.
  // `found: false` means "not (yet) there": the round may still be running,
  // so the client polls briefly before giving up.
  if (action === "result") {
    if (!requestId) return { error: "requestId is required" };
    const { data: round, error: roundErr } = await admin.from("agent_rounds")
      .select("response, trajectory_id")
      .eq("client_request_id", requestId).maybeSingle();
    if (roundErr) throw roundErr;
    if (!round?.response) return { found: false };
    const { data: traj } = await admin.from("agent_trajectories")
      .select("id").eq("id", round.trajectory_id).eq("user_id", user.id).maybeSingle();
    if (!traj) return { found: false };
    return { found: true, ...round.response };
  }

  // ── confirm: no model call, no rate-limit charge ─────────────────────────
  if (action === "confirm") {
    const trajectoryId = String(body.trajectoryId ?? "");
    const { data: traj } = await admin.from("agent_trajectories")
      .select("id, status").eq("id", trajectoryId).eq("user_id", user.id).maybeSingle();
    if (!traj) return { error: "trajectory not found", code: "TRAJECTORY_NOT_FOUND" };
    if (traj.status !== "open") return { error: `trajectory is ${traj.status}`, code: "TRAJECTORY_CLOSED" };
    const { data: round } = await admin.from("agent_rounds")
      .select("id, proposed_plan, input_context").eq("trajectory_id", trajectoryId)
      .eq("outcome", "proposed").order("round_index", { ascending: false })
      .limit(1).maybeSingle();
    if (!round) return { error: "no open proposal to confirm", code: "NO_OPEN_PROPOSAL" };
    // Belt and braces: never commit a plan that no longer validates.
    const check = validatePlan(round.proposed_plan, { baseline: round.input_context?.plan });
    if (!check.ok) return { error: "proposal failed validation", detail: formatValidation(check), code: "PROPOSAL_INVALID" };
    await admin.from("agent_rounds").update({ outcome: "accepted" }).eq("id", round.id);
    await admin.from("agent_trajectories")
      .update({ status: "accepted", updated_at: new Date().toISOString() }).eq("id", trajectoryId);
    return { plan: round.proposed_plan, baseline: round.input_context?.plan };
  }

  // ── propose / critique: model-calling rounds ─────────────────────────────
  const message = String(body.message ?? "").trim();
  if (!message) return { error: "message is required" };

  const today = new Date().toISOString().slice(0, 10);

  // The plan + run history come from the user's own app_state blob (RLS via
  // the caller's JWT) — the server-side source of truth, not the request body.
  // The daily budget (env default or per-user override) is fetched in parallel
  // so exposing it adds no latency to the hot path.
  const [stateResult, dailyLimit] = await Promise.all([
    userClient.from("app_state").select("data").eq("user_id", user.id).maybeSingle(),
    getDailyLimit(admin, user.id),
  ]);
  if (stateResult.error) throw stateResult.error;
  const blob = stateResult.data?.data ?? {};
  const plan = blob.rc_plan;
  const settings = blob.rc_settings ?? {};
  const userContext = cleanUserContext(blob.rc_user_context);
  if (!plan?.weeks?.length) return { error: "no training plan to adjust — build one first", code: "NO_PLAN" };
  // `id` + `hasDetail` give the model a handle for get_run_detail (and tell it
  // which runs have any detail to fetch) — no other fields leak into context.
  const recentRuns = (blob.rc_runs ?? []).slice(0, 30).map((r: Record<string, unknown>) => ({
    id: r.id, date: r.date, type: r.type, km: r.km, durationSec: r.durationSec, hr: r.hr, effort: r.effort,
    hasDetail: Boolean(r.routeId || r.hrRouteId),
  }));
  // Per-user daily budget; charge only after cheap request/state validation and
  // before any trajectory mutation. The increment is atomic (SQL function) so
  // concurrent requests can't slip past the limit. Returns the post-charge
  // usage either way (clamped to the limit on rejection — the counter keeps
  // climbing past the cap) so the client's ring reflects the spend after this
  // send, not just on a fresh `usage` read.
  const checkRateLimit = async (): Promise<{ error?: string; usage: { used: number; limit: number } }> => {
    const { data: count, error: usageErr } = await admin.rpc("increment_agent_usage", {
      p_user_id: user.id, p_day: today,
    });
    if (usageErr) throw usageErr;
    return count > dailyLimit
      ? { error: "daily coach limit reached — try again tomorrow", usage: { used: dailyLimit, limit: dailyLimit } }
      : { usage: { used: count, limit: dailyLimit } };
  };

  let trajectoryId: string;
  let usage: { used: number; limit: number };
  let history: unknown[] = [];
  let roundIndex = 0;
  let report = message;
  let baselinePlan = plan;
  let workingPlan = plan;

  if (action === "propose") {
    const rl = await checkRateLimit();
    if (rl.error) return { error: rl.error, code: "RATE_LIMIT", usage: rl.usage };
    usage = rl.usage;
    // One live conversation at a time: anything still open is now abandoned
    // (feedback given but never accepted — a distinct fate in the metrics).
    await admin.from("agent_trajectories")
      .update({ status: "abandoned", updated_at: new Date().toISOString() })
      .eq("user_id", user.id).eq("status", "open");
    const { data: traj, error } = await admin.from("agent_trajectories")
      .insert({ user_id: user.id }).select("id").single();
    if (error) throw error;
    trajectoryId = traj.id;
  } else {
    trajectoryId = String(body.trajectoryId ?? "");
    const { data: traj } = await admin.from("agent_trajectories")
      .select("id, status").eq("id", trajectoryId).eq("user_id", user.id).maybeSingle();
    if (!traj) return { error: "trajectory not found", code: "TRAJECTORY_NOT_FOUND" };
    if (traj.status !== "open") return { error: `trajectory is ${traj.status}`, code: "TRAJECTORY_CLOSED" };
    const { data: rounds, error } = await admin.from("agent_rounds")
      .select("round_index, user_feedback, rationale, tool_calls")
      .eq("trajectory_id", trajectoryId).order("round_index", { ascending: true });
    if (error) throw error;
    history = rounds ?? [];
    roundIndex = history.length;
    // Round 0's report anchors the conversation; fetch only that row's input_context.
    const { data: r0, error: r0Err } = await admin.from("agent_rounds")
      .select("input_context").eq("trajectory_id", trajectoryId).eq("round_index", 0).maybeSingle();
    if (r0Err) throw r0Err;
    report = r0?.input_context?.report ?? message;
    baselinePlan = r0?.input_context?.plan ?? plan;
    // Critiques edit the latest open proposal, not the persisted app_state
    // plan, so steering an open adjustment does not drop earlier edits.
    const { data: latestProposal, error: latestErr } = await admin.from("agent_rounds")
      .select("proposed_plan").eq("trajectory_id", trajectoryId).eq("outcome", "proposed")
      .order("round_index", { ascending: false }).limit(1).maybeSingle();
    if (latestErr) throw latestErr;
    workingPlan = latestProposal?.proposed_plan ?? baselinePlan;
    const rl = await checkRateLimit();
    if (rl.error) return { error: rl.error, code: "RATE_LIMIT", usage: rl.usage };
    usage = rl.usage;
  }

  // Derived runner age for the model's context: birthYear wins, legacy static
  // `age` is the fallback, implausible values (outside 10..90) read as unknown.
  // Keep in sync with runnerAge in src/utils/hr.ts (Deno can't import it).
  const yearNow = Number(today.slice(0, 4));
  const birthYear = Number(settings.birthYear) || 0;
  const byAge = yearNow - birthYear;
  const legacyAge = Number(settings.age) || 0;
  const runnerAge = birthYear && byAge >= 10 && byAge <= 90 ? byAge
    : legacyAge >= 10 && legacyAge <= 90 ? legacyAge : null;

  // Single goal shape for every consumer (buildMessages' prompt text AND
  // assessGoalFeasibility's tool result) — was previously duplicated at a
  // nested `goal.*` and a flat top level, which could silently drift apart.
  const context = {
    plan: workingPlan,
    recentRuns,
    today,
    report,
    runnerAge,
    goal: {
      raceDate: settings.raceDate || workingPlan.raceDate,
      distanceKm: Number(settings.distanceKm || workingPlan.distanceKm),
      goalSec: Number(settings.goalSec || workingPlan.goalSec) || null,
    },
    userContext,
    targetPace: workingPlan.targetPace,
    // Reply-language preference from the synced settings blob (validated to the
    // supported set); the engine steers only the model's prose, not tool I/O.
    replyLanguage: settings.language === "es" || settings.language === "fr" ? settings.language : "en",
  };

  const { model, callModel } = makeCallModel(context, message);
  // get_run_detail's data access: resolve the run in the user's own blob, read
  // its run_routes row through the RLS-scoped userClient, and collapse it to a
  // coordinate-free digest (runDigest.mjs) — raw GPS points and the full HR
  // stream never reach the model. Never throws: any miss or DB error becomes
  // an { unavailable } the engine reports as a plain tool_result.
  const fetchRunDetail = async (runId: string) => {
    try {
      const run = (blob.rc_runs ?? []).find((r: Record<string, unknown>) => r.id === runId);
      const routeId = (run?.routeId ?? run?.hrRouteId) as string | undefined;
      if (!run || !routeId) return { unavailable: "no detailed recording for this run" };
      const { data, error } = await userClient.from("run_routes")
        .select("points, stats").eq("id", routeId).maybeSingle();
      if (error || !data) return { unavailable: "no detailed recording for this run" };
      // A row can exist with nothing usable in it (empty points, no HR
      // samples) — answer as unavailable so it doesn't consume one of the
      // round's fetch-budget slots as a "successful" digest.
      const points = Array.isArray(data.points) ? data.points : [];
      const hrSamples = (data.stats as Record<string, unknown> | null)?.hrSamples;
      if (!points.length && !(Array.isArray(hrSamples) && hrSamples.length)) {
        return { unavailable: "no detailed data recorded for this run" };
      }
      return buildRunDigest({ run, points, stats: data.stats ?? {}, settings });
    } catch {
      return { unavailable: "run detail temporarily unavailable" };
    }
  };
  const result = await generateProposal({
    baseline: baselinePlan,
    context,
    history,
    message: action === "critique" ? message : null,
    callModel,
    fetchRunDetail,
  });

  const failed = result.status === "no_valid_adjustment";
  // A failed round only closes the WHOLE trajectory when there's no earlier
  // valid proposal to fall back on (round 0 failing means nothing was ever
  // proposed). A failed CRITIQUE (roundIndex > 0) leaves the trajectory
  // open — the prior "proposed" round is untouched below (only a
  // successful round supersedes it) — so the user can still confirm the
  // last adjustment that did validate instead of being dead-ended.
  const trajectoryClosed = failed && roundIndex === 0;
  // The exact body this round will answer with — built BEFORE the round is
  // logged so it can be stored on the row verbatim, letting the `result`
  // action replay it if the streamed response never reaches the client.
  const memorySuggestions = (result.memorySuggestions ?? [])
    .map((s: { text: string }, i: number) => ({ id: `${trajectoryId}:${roundIndex}:mem:${i}`, text: s.text }));
  const responseBody = failed
    ? {
      trajectoryId, roundIndex, status: "no_valid_adjustment", trajectoryClosed,
      rationale: result.rationale ||
        "I couldn't find an adjustment that keeps your plan safe — nothing was changed.",
      memorySuggestions,
      usage,
    }
    : {
      trajectoryId, roundIndex, status: "proposed",
      changed: result.changed,
      rationale: result.rationale,
      proposedPlan: result.plan,
      memorySuggestions,
      warnings: result.validation.warnings,
      usage,
    };
  // Log EVERY round, including failures — the audit log is the eval dataset.
  if (!failed && roundIndex > 0) {
    await admin.from("agent_rounds").update({ outcome: "superseded" })
      .eq("trajectory_id", trajectoryId).eq("outcome", "proposed");
  }
  const { error: roundErr } = await admin.from("agent_rounds").insert({
    trajectory_id: trajectoryId,
    round_index: roundIndex,
    user_feedback: action === "critique" ? message : null,
    tool_calls: result.toolCalls,
    rationale: result.rationale || null,
    proposed_plan: failed ? context.plan : result.plan,
    input_context: {
      report, goal: context.goal, today, recentRuns, userContext,
      baselinePlan, planSeenByModel: workingPlan,
      memorySuggestions: result.memorySuggestions ?? [],
      // Digests the model fetched via get_run_detail — part of what it saw,
      // so they belong in the audit snapshot (each is ~1-2KB, max 3/round).
      fetchedRunDetails: result.runDetailFetches ?? [],
      // Back-compat for existing confirm/client validation callers.
      plan: baselinePlan,
    },
    model,
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    outcome: failed ? "invalid" : "proposed",
    client_request_id: requestId,
    response: responseBody,
  });
  if (roundErr) throw roundErr;
  await admin.from("agent_trajectories")
    .update({
      status: trajectoryClosed ? "no_valid_adjustment" : "open",
      updated_at: new Date().toISOString(),
    })
    .eq("id", trajectoryId);

  return responseBody;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // First padding byte at t=0, not after one interval: it forces headers +
      // a body byte onto the wire immediately, so an intermediary never sees a
      // "started but silent" response during the model call.
      controller.enqueue(encoder.encode(" "));
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(" "));
        } catch {
          // Stream already closed (response finished); nothing to pad.
        }
      }, KEEPALIVE_INTERVAL_MS);

      handle(req)
        .catch((err) => {
          console.error("coach-agent error", err);
          return { error: "coach unavailable — try again in a moment", code: "COACH_UNAVAILABLE" };
        })
        .then((responseBody) => {
          clearInterval(keepAlive);
          try {
            controller.enqueue(encoder.encode(JSON.stringify(responseBody)));
            controller.close();
          } catch {
            // Connection already gone — the round is persisted with its
            // response body, so the client recovers it via `result`.
          }
        });
    },
  });

  // Status is always 200: the body carries the real outcome (see `handle`'s
  // doc comment above) because streaming means headers must go out before
  // that outcome is known.
  return new Response(stream, { headers: { ...CORS, "Content-Type": "application/json" } });
});
