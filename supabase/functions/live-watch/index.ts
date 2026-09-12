// live-watch — public read side of live run sharing. Callable WITHOUT a JWT:
// the share token IS the capability, and being signed in grants nothing extra.
// It exists instead of a token-scoped RLS policy because live_runs is keyed by
// user_id (a direct anon read would leak the runner's account UUID for a link
// meant to expose one run) and RLS cannot see a query parameter. A bad token, a
// run not yet started, a swept row and a finished run all answer an identical
// `{ live: false }`, so a crawler learns nothing and only the token's 128 bits
// stand between them and someone's run. Detail: docs/live-sharing.md.
//
// The token is DURABLE (v4): it resolves through `live_share_tokens`, whose
// rows are kept forever. So the ledger is authoritative for EXISTENCE, not
// just for activity — a retired token is a terminal "nothing live" and must
// never fall through to the legacy per-run column below, or replacing a link
// would hand the old address to whoever squatted that token on their own row.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isValidShareToken } from "../_shared/liveShare.mjs";

// Mirrors RESUME_MAX_AGE_MS / useLiveRun's MAX_AGE_MS on the client. Enforced
// HERE too, not just in the UI: a row left behind by a phone that never opens
// the app again is swept by nothing (see docs/live-sharing.md "Known limits"),
// and a public link must not keep serving someone's route for the rest of time
// because their battery died. Past this window the link goes dark on its own.
const MAX_AGE_MS = 6 * 3600 * 1000;

// Per-IP request budget. Defence in depth only — the token's entropy is the
// real control — so this is deliberately generous: a watcher polls every 30s,
// and several people watching the same run from one household NAT share an IP.
const RATE_WINDOW_MS = 60000;
const RATE_MAX = Number(Deno.env.get("LIVE_WATCH_RATE_MAX") ?? 60);
// Bound the bookkeeping so a spray of unique IPs can't grow the map unchecked.
const RATE_MAX_KEYS = 5000;

// `*` on purpose, matching route-suggest. Locking this to our own origin would
// protect nothing: the token is the capability, and anyone holding one can read
// the run from curl, where CORS does not apply. What actually limits abuse is
// the rate limit above and the fact that a token buys exactly one run.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// no-store, because a shared CDN/proxy cache keyed on the URL would go on
// serving a run's position after the runner ended the broadcast.
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });

// The one response for everything that is not a live run. Kept as a function so
// no branch below can accidentally give a probing client something to compare.
const notLive = () => json({ live: false });

const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(req: Request): boolean {
  // Supabase sits behind a proxy, so the socket address is useless; the first
  // hop in x-forwarded-for is the client. Spoofable, which is fine — this is a
  // courtesy limit, not an authorization boundary.
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now >= entry.resetAt) {
    if (hits.size >= RATE_MAX_KEYS) {
      for (const [key, v] of hits) if (now >= v.resetAt) hits.delete(key);
      if (hits.size >= RATE_MAX_KEYS) hits.clear(); // still full: start over rather than leak
    }
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_MAX;
}

// The token may arrive as ?t= (the page's own polling) or in a JSON body.
async function readToken(req: Request): Promise<string | null> {
  const fromQuery = new URL(req.url).searchParams.get("t");
  if (fromQuery) return fromQuery;
  if (req.method !== "POST") return null;
  const body = await req.json().catch(() => null) as { token?: unknown } | null;
  return typeof body?.token === "string" ? body.token : null;
}

// PostgREST answers a missing table from its schema cache (PGRST205) and the
// database answers 42P01 — both mean the migration hasn't been applied.
const isMissingRelation = (err: { code?: string | null } | null) =>
  err?.code === "PGRST205" || err?.code === "42P01";

// Service role: live_runs and live_share_tokens have no anon-readable policy
// at all, by design. Built through a factory so `Admin` is inferred from the
// real call rather than createClient's default generics, which don't match it.
const makeAdmin = () => createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
type Admin = ReturnType<typeof makeAdmin>;

// The one place a row becomes a response. Note the select list: user_id is NOT
// in it. Nothing that identifies the account may cross this boundary, and
// `share_public` is read to decide and then dropped.
async function serveRun(
  admin: Admin,
  by: { userId: string } | { legacyToken: string },
): Promise<Response> {
  const query = admin
    .from("live_runs")
    .select("status, started_at, updated_at, points, stats, share_public");
  const { data, error } = await ("userId" in by
    ? query.eq("user_id", by.userId)
    : query.eq("share_token", by.legacyToken)
  ).maybeSingle();

  // 42703 = undefined_column: share_public (or, on the legacy path,
  // share_token) hasn't been migrated yet. Closed direction, as above.
  if (error?.code === "42703") {
    console.error("live-watch: live_runs column missing — apply the pending live-sharing migration");
    return notLive();
  }
  if (error) throw error;
  if (!data) return notLive();

  const { share_public, ...run } = data as Record<string, unknown>;
  // The per-run opt-in. A row opened by a pre-v4 client leaves it false, so an
  // older bundle's broadcast can never light up a link it knew nothing about.
  // The legacy path carries its own opt-in: the token is ON that row.
  if ("userId" in by && share_public !== true) return notLive();

  // Server-side expiry. `updated_at` is trigger-stamped, so this is real
  // server time on both sides of the comparison.
  const updated = Date.parse(String(run.updated_at));
  if (!Number.isFinite(updated) || Date.now() - updated > MAX_AGE_MS) return notLive();

  // An `ended` run IS returned, deliberately: someone watching the finish
  // should see "this run has ended" rather than the page blinking into
  // "nothing here". The row is deleted moments later and the link goes dark on
  // the next poll anyway.
  return json({ live: true, run });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    // A refusal here is the one response that is NOT uniform, and it must not
    // be: a viewer whose household hit the limit needs to know to wait rather
    // than believe the run ended.
    if (rateLimited(req)) {
      return json({ error: "too many requests", code: "RATE_LIMIT" }, 429,
        { "Retry-After": String(Math.ceil(RATE_WINDOW_MS / 1000)) });
    }

    const token = await readToken(req);
    // Reject a malformed token before touching the database — a crawler walking
    // short strings costs us a regex, not a query. Same response as everything
    // else, so it stays indistinguishable from a well-formed miss.
    if (!isValidShareToken(token)) return notLive();

    const admin = makeAdmin();

    const claim = await admin
      .from("live_share_tokens")
      .select("user_id, revoked_at")
      .eq("token", token)
      .maybeSingle();

    // The ledger table may not exist yet: functions auto-deploy on push to
    // main, migrations are applied by hand. Answer "nothing live" rather than
    // 500 — the closed direction, and the page's normal empty view. A 500 is
    // read as "couldn't reach it" and retried forever, which would leave every
    // shared link stuck in an error state for the whole window.
    if (isMissingRelation(claim.error)) {
      console.error("live-watch: live_share_tokens missing — apply the standing-link migration");
      return notLive();
    }
    if (claim.error) throw claim.error;

    if (claim.data) {
      // Retired, or an account since deleted: terminal. NOT a fall-through to
      // the legacy column — see the header.
      if (claim.data.revoked_at || !claim.data.user_id) return notLive();
      return await serveRun(admin, { userId: String(claim.data.user_id) });
    }

    // No ledger row at all: a link minted by a pre-v4 bundle, still within its
    // own run. Retire this branch (and revoke the column's write) once
    // min_supported_version clears the last bundle that mints one.
    return await serveRun(admin, { legacyToken: token });
  } catch (err) {
    console.error("live-watch error", err);
    // Never leak the failure shape to an anonymous caller. The page treats a
    // 500 as "couldn't reach it" and keeps polling, which is the right
    // behaviour for a transient DB hiccup mid-run.
    return json({ error: "unavailable" }, 500);
  }
});
