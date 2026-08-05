// live-publish — the native write side of live run sharing.
//
// While the screen is off, Android runs no WebView JS, so the app's foreground
// service uploads accepted GPS fixes here instead (docs/live-sharing.md,
// "Native screen-off uploads"). Callable WITHOUT a JWT (config.toml sets
// verify_jwt = false): the per-run publish_token IS the capability. A user JWT
// would expire mid-run in a process that can't refresh it; this token lives
// exactly as long as the row it writes to.
//
// The trust boundary is sharper than live-watch's because this endpoint
// WRITES. Three properties keep it honest:
//
//  * It can only ever CONTINUE a broadcast, never start or restart one — all
//    row work happens in the live_publish_append / live_publish_end RPCs,
//    which UPDATE/DELETE and never insert. Opening a broadcast stays the
//    client's RLS + premium-gated INSERT, so "starting is the privileged act,
//    continuing never is" survives the native path.
//  * Payloads are validated to a fixed shape and cap BEFORE the database, and
//    stats are whitelisted in the RPC — an unauthenticated caller cannot use
//    this as free jsonb storage.
//  * The uniform `{ live: false }` answers a bad token, a swept row, an ended
//    run and a stale row identically. It doubles as the native uploader's stop
//    signal: the run is over, disable yourself.
//
// The response contract is three-way and the native client depends on it:
//   `{ live: true }`  → batch accepted, drop it locally (capped: true means
//                       points were thinned but the broadcast is alive);
//   `{ live: false }` → the broadcast is gone: soft-latch, stop uploading;
//   4xx               → the batch itself is bad: DROP it, never retry it;
//   5xx / network     → transient: keep the batch, retry on a later fix.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isValidPublishToken, isValidPointBatch, sanitizeStats } from "../_shared/livePublish.mjs";

// Stricter than live-watch's read budget: one uploader per run writes every
// 30s, so even a phone with two runs' uploaders wedged on retries stays far
// under this. Watch reads are many-per-run; publishes are one-per-cadence.
const RATE_WINDOW_MS = 60000;
const RATE_MAX = Number(Deno.env.get("LIVE_PUBLISH_RATE_MAX") ?? 20);
const RATE_MAX_KEYS = 5000;

// `*` like live-watch: the callers are the native uploader (no CORS) and the
// app's own teardown fallback. The token is the authorization; CORS protects
// nothing here.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });

const notLive = () => json({ live: false });

const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(req: Request): boolean {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now >= entry.resetAt) {
    if (hits.size >= RATE_MAX_KEYS) {
      for (const [key, v] of hits) if (now >= v.resetAt) hits.delete(key);
      if (hits.size >= RATE_MAX_KEYS) hits.clear();
    }
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_MAX;
}

type PublishBody = { token?: unknown; end?: unknown; points?: unknown; stats?: unknown };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (rateLimited(req)) {
      return json({ error: "too many requests", code: "RATE_LIMIT" }, 429,
        { "Retry-After": String(Math.ceil(RATE_WINDOW_MS / 1000)) });
    }
    if (req.method !== "POST") return json({ error: "bad request" }, 400);

    const body = await req.json().catch(() => null) as PublishBody | null;
    // Malformed token: uniform miss, same as live-watch — a prober learns
    // nothing, and the token never appears in any log line.
    if (!isValidPublishToken(body?.token)) return notLive();
    const token = body!.token as string;

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Teardown by capability: endLiveRun's fallback for a session that can no
    // longer delete through RLS (signed out at save). Uniform answer either
    // way — whether a row died must not be observable to a prober.
    if (body!.end === true) {
      const { error } = await admin.rpc("live_publish_end", { p_token: token });
      if (error) {
        if (isMigrationMissing(error.code)) return migrationMissing();
        throw error;
      }
      return notLive();
    }

    // The batch shape is a hard 4xx, not a uniform miss: the native client
    // must distinguish "this batch is poison, drop it" from "the run is over".
    if (!isValidPointBatch(body!.points)) return json({ error: "bad batch" }, 400);

    const { data, error } = await admin.rpc("live_publish_append", {
      p_token: token,
      p_points: body!.points,
      p_stats: sanitizeStats(body!.stats),
    });
    if (error) {
      if (isMigrationMissing(error.code)) return migrationMissing();
      throw error;
    }
    // The RPC's own contract: { live: false } or { live: true, capped: bool }.
    return json(data ?? { live: false });
  } catch (err) {
    console.error("live-publish error", err);
    return json({ error: "unavailable" }, 500);
  }
});

// 42883 = undefined_function, 42703 = undefined_column: the publish-token
// migration hasn't been applied yet (functions auto-deploy on merge;
// migrations are applied by hand). Fail closed and loudly in the logs — but as
// a 500, NOT { live: false }: a healthy uploader mid-run must keep its batch
// and retry, not read a deploy-ordering gap as "the run ended".
function isMigrationMissing(code?: string | null): boolean {
  return code === "42883" || code === "42703";
}
function migrationMissing(): Response {
  console.error("live-publish: RPCs missing — apply the live_runs_publish_token migration");
  return json({ error: "unavailable" }, 500);
}
