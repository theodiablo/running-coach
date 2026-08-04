// live-watch — the public read side of live run sharing.
//
// Resolves a share token from a /watch/:token link to the run currently being
// broadcast under it. Callable WITHOUT a JWT (config.toml sets
// verify_jwt = false for this function): the token IS the capability, and being
// signed in grants nothing extra here.
//
// Why this exists at all instead of a token-scoped RLS policy on live_runs:
//
//  * `user_id` is that table's primary key. A direct anon read would hand every
//    viewer the runner's account UUID, permanently, for a link meant to expose
//    one run. The response below carries the trace and nothing that identifies
//    the account.
//  * RLS has no access to a query parameter, so a policy version would mean
//    smuggling the token through a header — more moving parts, weaker result.
//  * The uniform response and the rate limit below are code, not policy.
//
// THE UNIFORM RESPONSE is the anti-probing property. A bad token, a good token
// whose run has not started, a swept row and a run that ended hours ago all
// return exactly `{ live: false }`. A crawler therefore learns nothing from a
// response — not even whether a token exists — so the only thing standing
// between them and someone's run is the 128 bits of entropy in the token, which
// is a wall, not a speed bump. It doubles as the pre-run experience: a runner
// can send the link the night before and the page simply says nothing is live
// yet, because that is true.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isValidShareToken, LIVE_MAX_AGE_MS } from "../_shared/liveShare.mjs";
import { CORS as SHARED_CORS, json as sharedJson } from "../_shared/cors.mjs";

// Per-IP request budget. Defence in depth only — the token's entropy is the
// real control — so this is deliberately generous: a watcher polls every 30s,
// and several people watching the same run from one household NAT share an IP.
const RATE_WINDOW_MS = 60000;
const RATE_MAX = Number(Deno.env.get("LIVE_WATCH_RATE_MAX") ?? 60);
// Bound the bookkeeping so a spray of unique IPs can't grow the map unchecked.
const RATE_MAX_KEYS = 5000;

// Shared headers (`*` rationale in _shared/cors.mjs — here the token is the
// capability and curl needs no CORS), plus the methods this unauthenticated
// endpoint answers, for the preflight response.
const CORS = { ...SHARED_CORS, "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

// no-store, because a shared CDN/proxy cache keyed on the URL would go on
// serving a run's position after the runner ended the broadcast.
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  sharedJson(body, status, { "Cache-Control": "no-store", ...extra });

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

    // Service role: live_runs has no anon-readable policy at all, by design.
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Note the select list: user_id is NOT in it. Nothing that identifies the
    // account may cross this boundary.
    const { data, error } = await admin
      .from("live_runs")
      .select("status, started_at, updated_at, points, stats")
      .eq("share_token", token)
      .maybeSingle();

    // 42703 = undefined_column: the share-token migration hasn't been applied
    // yet (functions auto-deploy on push to main; migrations are applied by
    // hand). Nothing can be shared in that state, so answer "nothing live"
    // rather than 500 — the closed direction, and the page's normal empty view.
    if (error?.code === "42703") {
      console.error("live-watch: live_runs.share_token missing — apply the share-token migration");
      return notLive();
    }
    if (error) throw error;
    if (!data) return notLive();

    // Server-side expiry, enforced HERE too, not just in the UI (see
    // liveShare.mjs). `updated_at` is trigger-stamped, so this is real server
    // time on both sides of the comparison.
    const updated = Date.parse(String(data.updated_at));
    if (!Number.isFinite(updated) || Date.now() - updated > LIVE_MAX_AGE_MS) return notLive();

    // An `ended` run IS returned, deliberately: someone watching the finish
    // should see "this run has ended" rather than the page blinking into
    // "nothing here". The row is deleted moments later and the link goes dark
    // on the next poll anyway.
    return json({ live: true, run: data });
  } catch (err) {
    console.error("live-watch error", err);
    // Never leak the failure shape to an anonymous caller. The page treats a
    // 500 as "couldn't reach it" and keeps polling, which is the right
    // behaviour for a transient DB hiccup mid-run.
    return json({ error: "unavailable" }, 500);
  }
});
