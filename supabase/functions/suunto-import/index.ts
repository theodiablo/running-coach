// suunto-import — server side of the Suunto cloud import: holds the OAuth
// secret, subscription key and the user's tokens, never returned to the client.
// Actions: status, exchange, sync (one page of workout summaries), fit (one
// FIT file), ack (advance the cursor + drain staged rows), disconnect.
//
// Suunto has no Polar-style server-side transaction, so the sync protocol is a
// cursor + deferred ack owned by this function's integration_connections row:
//   - sync NEVER advances the cursor; it lists workouts since the stored
//     watermark, filters, and returns summaries. The client fetches FITs one
//     per `fit` call (each invocation stays under the client's 15s timeout) and
//     acks only AFTER the runs are actually saved — an unacked page is simply
//     re-served, so a missed toast or a frozen WebView never loses history.
//   - webhook-staged workouts (suunto-webhook) ride along flagged `staged` and
//     are acked by key, NEVER via the cursor: a staged workout is today's run
//     arriving mid-backfill, and letting it advance the watermark would skip
//     everything between the backfill position and today.
// Can't be exercised in CI (live Suunto cloud + partner credentials) — the
// endpoint paths, `since` semantics, JWT username claim and activity ids are
// each isolated below and marked CALIBRATE for the first live pass.
// Architecture, protocol, deploy/secrets: docs/integrations-suunto.md.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  fitVariantAuth, fitVariantPath, fitVariantsToTry, looksLikeFit,
} from "../_shared/suunto/fitExport.mjs";

const SUUNTO_CLIENT_ID = Deno.env.get("SUUNTO_CLIENT_ID");
const SUUNTO_CLIENT_SECRET = Deno.env.get("SUUNTO_CLIENT_SECRET");
const SUUNTO_SUBSCRIPTION_KEY = Deno.env.get("SUUNTO_SUBSCRIPTION_KEY");
const hasSuuntoCreds = Boolean(SUUNTO_CLIENT_ID && SUUNTO_CLIENT_SECRET && SUUNTO_SUBSCRIPTION_KEY);

const TOKEN_URL = "https://cloudapi-oauth.suunto.com/oauth/token";
const API = "https://cloudapi.suunto.com";
// Documented v3 listing. `since`/`until` filter on START time unless
// `filter-by-modification-time` is set — deliberately left off: `sync_cursor`
// holds start times, and switching an existing row's watermark to a different
// clock mid-flight would skip or replay history. Moving to it (and dropping the
// overlap re-list it subsumes) is a migration of its own; docs/integrations-suunto.md.
const LIST_PATH = (since: number, limit: number) => `${API}/v3/workouts/?since=${since}&limit=${limit}`;
// Pre-v3 shape, tried only if the v3 listing rejects the request. The two
// versions coexist, and a listing that silently stops working reads as
// "the sync button found nothing" — the failure this whole file is careful about.
const LIST_PATH_LEGACY = (since: number, limit: number) => `${API}/v2/workouts?since=${since}&limit=${limit}`;

const LIST_LIMIT = 100;             // workouts listed per sync
const PAGE_MAX = 50;                // summaries returned per sync (clamp on pageSize)
const OVERLAP_MS = 30 * 24 * 3600_000;   // late-upload net: re-list a trailing window…
const OVERLAP_EVERY_MS = 24 * 3600_000;  // …at most once a day
const STAGED_TTL_MS = 30 * 24 * 3600_000; // staged rows the app never drained
const FIT_DAILY_LIMIT = Number(Deno.env.get("SUUNTO_FIT_DAILY_LIMIT") || 300);

// CALIBRATE against Suunto's activity-id table. Anything not listed here is
// skipped BEFORE its FIT is downloaded (the subscription key is an app-wide
// quota) — stricter than Polar's unknown-passes-through, so skipped ids are
// logged for diagnosis and this list is the fix.
const RUN_ACTIVITY_IDS = new Set([3 /* running */, 22 /* treadmill */, 82 /* trail running */]);
const WALK_ACTIVITY_IDS = new Set([1 /* walking */, 13 /* hiking */, 24 /* nordic walking */]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type ConnectionRow = {
  external_user_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  sync_cursor: number;
  sync_state: Record<string, unknown> | null;
};

type WorkoutSummary = Record<string, unknown>;

// ── OAuth ───────────────────────────────────────────────────────────────────

// Error hygiene: token-endpoint failures surface only the HTTP status and the
// OAuth `error` code — never the request, headers or full response body (the
// catch-all at the bottom echoes `String(err)` to the client).
async function tokenRequest(params: Record<string, string>) {
  const basic = btoa(`${SUUNTO_CLIENT_ID}:${SUUNTO_CLIENT_SECRET}`);
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: new URLSearchParams(params),
    });
  } catch {
    throw new Error("suunto token endpoint unreachable");
  }
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof body.error === "string" ? body.error : "unknown";
    const err = new Error(`suunto token request failed: ${res.status} ${code}`);
    (err as Error & { oauthError?: string }).oauthError = code;
    throw err;
  }
  return body as { access_token?: string; refresh_token?: string; expires_in?: number };
}

// The Suunto access token is a JWT whose payload names the authorizing app
// account — that username is how webhook notifications are mapped back to app
// users. CALIBRATE the claim name ("user" per the docs; fallbacks defensive).
function usernameFromJwt(accessToken: string): string {
  try {
    const payload = accessToken.split(".")[1];
    const pad = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(pad)) as Record<string, unknown>;
    for (const k of ["user", "username", "sub"]) {
      if (typeof claims[k] === "string" && claims[k]) return claims[k] as string;
    }
  } catch { /* fall through */ }
  return "";
}

// Fresh access token for the row, refreshing (and persisting the rotation)
// when needed. Concurrency-safe: rotation uses a compare-and-swap on the OLD
// refresh token, and invalid_grant re-reads before concluding anything — a
// phone/tablet refresh race must never delete a good credential. On a genuine
// dead refresh token the row is KEPT (cursor + username preserved so webhook
// staging keeps working) and flagged needs_reauth. Rows with a null
// expires_at never expire (Polar-style) and are returned untouched.
async function getFreshToken(
  admin: SupabaseClient, userId: string, row: ConnectionRow, force = false,
): Promise<{ token: string } | "reauth"> {
  if (!row.refresh_token || !row.expires_at) return { token: row.access_token };
  const msLeft = Date.parse(row.expires_at) - Date.now();
  if (!force && msLeft > 60_000) return { token: row.access_token };

  const attempted = row.refresh_token;
  let tok: Awaited<ReturnType<typeof tokenRequest>>;
  try {
    tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: attempted });
  } catch (err) {
    if ((err as Error & { oauthError?: string }).oauthError !== "invalid_grant") throw err;
    // invalid_grant: either the user revoked access, or a concurrent sync
    // already rotated this token. Re-read before deciding which.
    const { data } = await admin.from("integration_connections")
      .select("external_user_id, access_token, refresh_token, expires_at, sync_cursor, sync_state")
      .eq("user_id", userId).eq("provider", "suunto").maybeSingle();
    const current = data as ConnectionRow | null;
    if (current && current.refresh_token && current.refresh_token !== attempted) {
      return await getFreshToken(admin, userId, current, force);
    }
    await admin.from("integration_connections")
      .update({ sync_state: { ...(current?.sync_state || {}), needs_reauth: true }, updated_at: new Date().toISOString() })
      .eq("user_id", userId).eq("provider", "suunto");
    return "reauth";
  }
  if (!tok.access_token) throw new Error("suunto refresh returned no access token");

  const update = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || attempted,
    expires_at: new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  // CAS on the token we refreshed FROM: if another invocation rotated first,
  // 0 rows match — keep ours for this request (it's valid) without clobbering.
  await admin.from("integration_connections").update(update)
    .eq("user_id", userId).eq("provider", "suunto").eq("refresh_token", attempted);
  return { token: tok.access_token };
}

// ── Suunto Cloud API ────────────────────────────────────────────────────────

async function apiFetch(
  admin: SupabaseClient, userId: string, row: ConnectionRow, url: string, accept: string,
): Promise<Response | "reauth"> {
  let fresh = await getFreshToken(admin, userId, row);
  if (fresh === "reauth") return "reauth";
  const doFetch = (token: string) => fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Ocp-Apim-Subscription-Key": SUUNTO_SUBSCRIPTION_KEY!,
      "Accept": accept,
    },
  });
  let res = await doFetch(fresh.token);
  if (res.status === 401) {
    // Expiry raced the clock check — one forced refresh, then give up.
    fresh = await getFreshToken(admin, userId, row, true);
    if (fresh === "reauth") return "reauth";
    res = await doFetch(fresh.token);
  }
  return res;
}

// `gone` = every attempt was a hard "no FIT here" on a calibrated endpoint.
// `notFit` = something answered 2xx with a body that isn't a FIT, which is a
// different problem from a rejection and deserves its own line in the logs.
type FitMiss = { gone: boolean; status: number; notFit: boolean };

const fitVariantMemo = (row: ConnectionRow): string => {
  const v = row.sync_state?.fitVariant;
  return typeof v === "string" ? v : "";
};

// Download one workout's FIT, calibrating the export endpoint as it goes:
// candidates are tried in order and the one that returns real FIT bytes is
// remembered on the row (_shared/suunto/fitExport.mjs explains why this is a
// ladder and not a constant). A miss reports whether every attempt was a hard
// "no FIT here" — which only means the workout has none once the endpoint is
// calibrated, since before that it equally means no path was right.
async function fetchWorkoutFit(
  admin: SupabaseClient, userId: string, row: ConnectionRow, key: string,
): Promise<{ bytes: Uint8Array; variantId: string } | FitMiss | "reauth"> {
  const first = await getFreshToken(admin, userId, row);
  if (first === "reauth") return "reauth";
  let token = first.token;
  let refreshed = false;

  const memo = fitVariantMemo(row);
  const variants = fitVariantsToTry(memo);
  let lastStatus = 0;
  let allGone = true;
  let notFit = false;

  for (const variant of variants) {
    const get = () => fetch(`${API}${fitVariantPath(variant, key)}`, {
      headers: {
        "Authorization": fitVariantAuth(variant, token),
        "Ocp-Apim-Subscription-Key": SUUNTO_SUBSCRIPTION_KEY!,
        "Accept": "application/octet-stream",
      },
    });
    let res = await get();
    if (res.status === 401 && !refreshed) {
      // Expiry raced the clock check — one forced refresh for the whole ladder.
      refreshed = true;
      const forced = await getFreshToken(admin, userId, row, true);
      if (forced === "reauth") return "reauth";
      token = forced.token;
      res = await get();
    }
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (looksLikeFit(bytes)) return { bytes, variantId: variant.id };
      // A 2xx that isn't a FIT — this path answers something else (an APIM
      // notice, or an envelope pointing at a download URL).
      notFit = true;
      allGone = false;
      lastStatus = res.status;
      continue;
    }
    lastStatus = res.status;
    if (res.status !== 404 && res.status !== 410) { allGone = false; continue; }
    // A hard miss on the CALIBRATED endpoint is the real answer; don't spend
    // the other requests re-asking paths that can't know better.
    if (memo === variant.id) break;
  }
  return { gone: allGone && !!memo, status: lastStatus, notFit };
}

const workoutKeyOf = (w: WorkoutSummary): string =>
  w.workoutKey != null ? String(w.workoutKey) : (w.key != null ? String(w.key) : "");
const startTimeOf = (w: WorkoutSummary): number => Number(w.startTime) || 0;
const activityIdOf = (w: WorkoutSummary): number | null =>
  w.activityId != null && !Number.isNaN(Number(w.activityId)) ? Number(w.activityId) : null;
const isImportableActivity = (w: WorkoutSummary): boolean => {
  const id = activityIdOf(w);
  return id != null && (RUN_ACTIVITY_IDS.has(id) || WALK_ACTIVITY_IDS.has(id));
};

function b64(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000; // String.fromCharCode arg-count limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

// ── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const payload = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = typeof payload.action === "string" ? payload.action : "status";

    // Resolve the caller from their JWT (forwarded by functions.invoke).
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "unauthorized" }, 401);
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: auth } = await userClient.auth.getUser();
    const user = auth?.user;
    if (!user) return json({ error: "unauthorized" }, 401);

    if (!hasSuuntoCreds) return json({ skipped: "suunto not configured", connected: false });

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const loadRow = async (): Promise<ConnectionRow | null> => {
      const { data } = await admin.from("integration_connections")
        .select("external_user_id, access_token, refresh_token, expires_at, sync_cursor, sync_state")
        .eq("user_id", user.id).eq("provider", "suunto").maybeSingle();
      return data as ConnectionRow | null;
    };

    if (action === "status") {
      const row = await loadRow();
      return json({ connected: !!row && !row.sync_state?.needs_reauth });
    }

    if (action === "disconnect") {
      await admin.from("integration_connections").delete()
        .eq("user_id", user.id).eq("provider", "suunto");
      await admin.from("integration_staged_workouts").delete()
        .eq("user_id", user.id).eq("provider", "suunto");
      return json({ ok: true });
    }

    if (action === "exchange") {
      const code = typeof payload.code === "string" ? payload.code : "";
      const redirectUri = typeof payload.redirectUri === "string" ? payload.redirectUri : "";
      const codeVerifier = typeof payload.codeVerifier === "string" ? payload.codeVerifier : undefined;
      if (!code || !redirectUri) return json({ error: "code and redirectUri are required" }, 400);
      const tok = await tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
      });
      if (!tok.access_token || !tok.refresh_token) throw new Error("suunto exchange returned no tokens");
      const username = usernameFromJwt(tok.access_token);
      if (!username) throw new Error("suunto token carried no username claim");
      const existing = await loadRow();
      // Same account re-authorizing (e.g. after needs_reauth): keep the cursor —
      // a routine re-auth must not replay the full-history backfill. A NEW or
      // different account starts at 0 and drops the old account's staged rows,
      // whose keys would 4xx against the new token.
      const sameAccount = existing?.external_user_id === username;
      if (!sameAccount) {
        await admin.from("integration_staged_workouts").delete()
          .eq("user_id", user.id).eq("provider", "suunto");
      }
      const { error } = await admin.from("integration_connections").upsert({
        user_id: user.id,
        provider: "suunto",
        external_user_id: username,
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_at: new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000).toISOString(),
        sync_cursor: sameAccount ? existing!.sync_cursor : 0,
        sync_state: {},
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      return json({ connected: true });
    }

    if (action === "sync") {
      const row = await loadRow();
      if (!row) return json({ connected: false, workouts: [] });
      const knownKeys = new Set(
        Array.isArray(payload.knownKeys) ? (payload.knownKeys as unknown[]).map(String) : [],
      );
      const pageSize = Math.min(Math.max(Number(payload.pageSize) || PAGE_MAX, 1), PAGE_MAX);

      // Staged (webhook-announced) workouts ride along, flagged. Expire rows
      // the app never drained — the since-cursor list still covers those
      // workouts, so expiry loses nothing.
      await admin.from("integration_staged_workouts").delete()
        .eq("user_id", user.id).eq("provider", "suunto")
        .lt("created_at", new Date(Date.now() - STAGED_TTL_MS).toISOString());
      const { data: stagedRows } = await admin.from("integration_staged_workouts")
        .select("external_key, payload")
        .eq("user_id", user.id).eq("provider", "suunto");
      const staged = (stagedRows || []) as { external_key: string; payload: WorkoutSummary | null }[];

      // Late-upload net: a watch that syncs days later produces a workout whose
      // startTime is already below the cursor — invisible to a pure since-list
      // if webhooks missed it (outage, circuit breaker). At most once a day,
      // re-list a trailing window; knownKeys + the ack RPC's greatest() make
      // the overlap cheap and rewind-proof.
      const lastOverlap = Number(row.sync_state?.lastOverlapCheck) || 0;
      const overlapDue = row.sync_cursor > 0 && Date.now() - lastOverlap > OVERLAP_EVERY_MS;
      const since = overlapDue ? Math.max(0, row.sync_cursor - OVERLAP_MS) : row.sync_cursor;
      if (overlapDue) {
        await admin.from("integration_connections")
          .update({ sync_state: { ...(row.sync_state || {}), lastOverlapCheck: Date.now() } })
          .eq("user_id", user.id).eq("provider", "suunto");
      }

      let listRes = await apiFetch(admin, user.id, row, LIST_PATH(since, LIST_LIMIT), "application/json");
      if (listRes === "reauth") return json({ connected: false, reauth: true, workouts: [] });
      if (!listRes.ok) {
        // The v2 listing is what shipped and what is known to work on live
        // accounts; keep it as the net rather than turning a version mismatch
        // into "no new runs" for everyone.
        console.warn("suunto-import v3 list failed, falling back to v2", listRes.status);
        listRes = await apiFetch(admin, user.id, row, LIST_PATH_LEGACY(since, LIST_LIMIT), "application/json");
        if (listRes === "reauth") return json({ connected: false, reauth: true, workouts: [] });
      }
      if (!listRes.ok) throw new Error(`suunto workout list failed: ${listRes.status}`);
      const listBody = await listRes.json().catch(() => ({})) as Record<string, unknown>;
      // CALIBRATE: Suunto responses wrap arrays in `payload`.
      const listedRaw = Array.isArray(listBody.payload) ? listBody.payload
        : Array.isArray(listBody.workouts) ? listBody.workouts
        : Array.isArray(listBody) ? listBody as unknown[] : [];
      const listed = (listedRaw as WorkoutSummary[])
        .filter(w => workoutKeyOf(w))
        .sort((a, b) => startTimeOf(a) - startTimeOf(b));

      // Walk ascending. The returned cursor covers every walked workout —
      // including deliberately-skipped ones (wrong activity type, knownKeys),
      // otherwise 100 consecutive cycling workouts would wedge the watermark
      // forever. It is start-time based WITHOUT +1 (equal-startTime workouts
      // split across a page boundary re-list once; knownKeys absorbs that),
      // and the client only acks it after saving.
      const listedKeys = new Set<string>();
      const workouts: { key: string; startTime: number; staged: boolean; summary: WorkoutSummary }[] = [];
      let cursor = row.sync_cursor;
      let truncated = false;
      const skippedActivityIds = new Set<number>();
      for (const w of listed) {
        if (workouts.length >= pageSize) { truncated = true; break; }
        const key = workoutKeyOf(w);
        listedKeys.add(key);
        cursor = Math.max(cursor, startTimeOf(w));
        if (!isImportableActivity(w)) {
          const id = activityIdOf(w);
          if (id != null) skippedActivityIds.add(id);
          continue;
        }
        if (knownKeys.has(key)) continue;
        workouts.push({ key, startTime: startTimeOf(w), staged: false, summary: w });
      }
      if (skippedActivityIds.size) {
        console.log("suunto-import skipped activity ids", [...skippedActivityIds].join(","));
      }

      // Staged workouts not already covered by the list walk. Ones that are
      // known/filtered still get their keys returned so ack can drain them.
      const stagedKeys: string[] = [];
      for (const s of staged) {
        if (listedKeys.has(s.external_key)) { stagedKeys.push(s.external_key); continue; }
        const summary = s.payload || {};
        stagedKeys.push(s.external_key);
        if (knownKeys.has(s.external_key) || (activityIdOf(summary) != null && !isImportableActivity(summary))) continue;
        workouts.push({
          key: s.external_key,
          startTime: startTimeOf(summary),
          staged: true,
          summary,
        });
      }

      // Counts only, no workout data. "Nothing imported" has several very
      // different causes — the list came back empty (cursor past everything, or
      // a wrong `since` unit), everything was filtered as non-run, or the client
      // already knew it all — and they are indistinguishable from the client.
      console.log(`suunto-import sync since=${since} listed=${listed.length} offered=${workouts.length} staged=${staged.length} known=${knownKeys.size}`);

      return json({
        connected: true,
        workouts,
        cursor,
        stagedKeys,
        hasMore: truncated || listed.length >= LIST_LIMIT,
      });
    }

    if (action === "fit") {
      const key = typeof payload.key === "string" ? payload.key : "";
      if (!key) return json({ error: "key is required" }, 400);
      const row = await loadRow();
      if (!row) return json({ connected: false, transient: true });
      // Per-user daily cap: FIT downloads spend the app-wide subscription-key
      // quota, so a runaway client must not be able to burn it for everyone.
      // Over-cap is TRANSIENT (tomorrow's scan resumes), never summary-fallback.
      const { data: count } = await admin.rpc("increment_integration_sync_usage", {
        p_user_id: user.id, p_provider: "suunto", p_day: new Date().toISOString().slice(0, 10),
      });
      if (typeof count === "number" && count > FIT_DAILY_LIMIT) {
        return json({ connected: true, transient: true, quota: true });
      }
      let res: Awaited<ReturnType<typeof fetchWorkoutFit>>;
      try {
        res = await fetchWorkoutFit(admin, user.id, row, key);
      } catch {
        return json({ connected: true, transient: true }); // network — retry next scan
      }
      if (res === "reauth") return json({ connected: false, reauth: true, transient: true });
      if ("bytes" in res) {
        if (res.variantId !== fitVariantMemo(row)) {
          // Remember the endpoint that worked, so every later download is one
          // request. Logged because it is the answer to the question the code
          // couldn't: which export path Suunto actually serves.
          await admin.from("integration_connections")
            .update({ sync_state: { ...(row.sync_state || {}), fitVariant: res.variantId } })
            .eq("user_id", user.id).eq("provider", "suunto");
          console.log("suunto-import fit endpoint calibrated", res.variantId);
        }
        return json({ connected: true, fit: b64(res.bytes) });
      }
      // Only a hard "this workout has no FIT" on the calibrated endpoint is
      // terminal (client falls back to the summary). Everything else —
      // including every miss before the endpoint is calibrated — is transient:
      // marking it terminal would permanently import summary-only runs, the
      // exact failure that shipped (a 401 on every download, which on the
      // client looks like "no route", never like an endpoint error).
      //
      // Both misses are LOGGED, status only — never the key, the body or a header.
      if (res.gone) {
        console.warn("suunto-import fit missing", res.status);
        return json({ connected: true, gone: true });
      }
      // Called out separately: "answered, but not with a FIT" points at the
      // response SHAPE (an envelope, a redirect page), not at the endpoint
      // being wrong — a different fix from a 401 or a 404.
      if (res.notFit) console.error("suunto-import fit body was not a FIT", res.status);
      console.error("suunto-import fit failed", res.status);
      return json({ connected: true, transient: true, status: res.status });
    }

    if (action === "ack") {
      const cursor = Number(payload.cursor);
      if (Number.isFinite(cursor) && cursor > 0) {
        await admin.rpc("ack_integration_cursor", {
          p_user_id: user.id, p_provider: "suunto", p_cursor: Math.round(cursor),
        });
      }
      const stagedKeys = Array.isArray(payload.stagedKeys)
        ? (payload.stagedKeys as unknown[]).map(String).filter(Boolean) : [];
      if (stagedKeys.length) {
        await admin.from("integration_staged_workouts").delete()
          .eq("user_id", user.id).eq("provider", "suunto")
          .in("external_key", stagedKeys);
      }
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    console.error("suunto-import error", err instanceof Error ? err.message : String(err));
    return json({ error: err instanceof Error ? err.message : String(err) }, 200); // never hard-fail the caller's scan
  }
});
