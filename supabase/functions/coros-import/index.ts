// coros-import — server side of the COROS cloud import: holds the OAuth secret
// and the user's tokens, never returned to the client. Actions: status,
// exchange, sync (one page of workout summaries), file (one activity file),
// ack (advance the cursor + drain staged rows), disconnect.
//
// SHIPPED DORMANT, AND DELIBERATELY INCOMPLETE. COROS publishes no technical
// API documentation before a developer application is approved — the public
// help centre describes the onboarding process and states the API is OAuth 2.0,
// and nothing more. So this function knows COROS's *protocol* (OAuth 2.0,
// RFC 6749) but none of its *addresses or payloads*: token endpoint, API host,
// listing and download paths, and every field name are unknown.
//
// Rather than guess them, the vendor-specific values below are EMPTY constants
// marked TODO(coros-api), and `API_DOCUMENTED` keeps every action that would
// touch COROS returning {skipped}. The actions that touch only our own tables
// (status, ack, disconnect) are complete and correct today.
//
// The reason for the discipline is on the record: Suunto shipped against
// inferred endpoints and needed two follow-up PRs (#202, #203) for a sync that
// reported "no new runs" and imports that arrived with no route — and that was
// WITH credentials and a live account to test against. A wrong endpoint is
// invisible from the app; it just looks like nothing new happened.
//
// The sync protocol itself is OURS, not COROS's, and is the one Suunto proved:
// a cursor + deferred ack owned by this function's integration_connections row.
//   - sync NEVER advances the cursor; it lists workouts since the stored
//     watermark, filters, and returns summaries. The client fetches files one
//     per `file` call and acks only AFTER the runs are saved, so an unacked
//     page is simply re-served and a missed toast never loses history.
//   - webhook-staged workouts (if COROS offers webhooks — unknown) ride along
//     flagged `staged` and are acked BY KEY, never via the cursor: a staged
//     workout is today's run arriving mid-backfill, and letting it move the
//     watermark would skip everything in between.
// Architecture, protocol, activation checklist: docs/integrations-coros.md.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const COROS_CLIENT_ID = Deno.env.get("COROS_CLIENT_ID");
const COROS_CLIENT_SECRET = Deno.env.get("COROS_CLIENT_SECRET");
const hasCorosCreds = Boolean(COROS_CLIENT_ID && COROS_CLIENT_SECRET);

// ── TODO(coros-api) ─────────────────────────────────────────────────────────
// Every value here comes from the COROS API pack issued at onboarding. They are
// empty on purpose: an empty URL can only fail loudly and visibly, whereas a
// plausible-but-wrong one ships a sync that silently reports "no new runs".
//
// Needed before this function can do anything:
//   1. TOKEN_URL and the token-endpoint auth style. The grant shapes below are
//      RFC 6749 standard (authorization_code, refresh_token), which is what
//      "standard OAuth 2.0 API framework" implies, but whether the client
//      credentials go in an HTTP Basic header or in the form body is a
//      per-vendor choice — CLIENT_AUTH_IN_BODY switches it.
//   2. API base + the workout LISTING path, and its `since`/paging semantics
//      (is the filter on start time or on modification time? epoch seconds or
//      ms? page/offset or cursor?). `sync_cursor` holds epoch MILLISECONDS of a
//      start time; if COROS filters on something else, that is a cursor
//      migration, not a units tweak.
//   3. The activity-FILE download path and its format (FIT is assumed — it is
//      what COROS watches record and what the app already parses; if it is GPX
//      or TCX, the client's mapper routes through parseActivityFile instead).
//   4. Whether a subscription/app key beyond the OAuth token is required
//      (Suunto needs Ocp-Apim-Subscription-Key), and the published rate limits.
//   5. The sport/activity-type vocabulary — which values mean run and which
//      mean walk — so normalizeWorkout can filter non-run activities BEFORE
//      their file is ever downloaded against a metered quota.
//   6. Every field name normalizeWorkout() reads.
// Flip API_DOCUMENTED once 1-6 are real, and mirror the client's API_DOCUMENTED
// in src/imports/providers/coros.ts.
// Typed `boolean`, not the inferred `false`, so the guards below stay ordinary
// runtime checks instead of branches the compiler prunes as unreachable.
const API_DOCUMENTED: boolean = false;
const TOKEN_URL = "";
const API = "";
const CLIENT_AUTH_IN_BODY = false;
const LIST_PATH = (_since: number, _limit: number): string => "";
const FILE_PATH = (_key: string): string => "";
// ────────────────────────────────────────────────────────────────────────────

const LIST_LIMIT = 100;                   // workouts listed per sync
const PAGE_MAX = 50;                      // summaries returned per sync
const STAGED_TTL_MS = 30 * 24 * 3600_000; // staged rows the app never drained
const FILE_DAILY_LIMIT = Number(Deno.env.get("COROS_FILE_DAILY_LIMIT") || 300);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Every action that would reach COROS answers this until the API pack lands.
// Shaped like a connected-but-empty sync so the client's scan loop treats it as
// "nothing to do" rather than as an error worth retrying.
const notDocumented = () =>
  json({ skipped: "coros api not documented", connected: false, workouts: [] });

type ConnectionRow = {
  external_user_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  sync_cursor: number;
  sync_state: Record<string, unknown> | null;
};

type RawWorkout = Record<string, unknown>;

// What the client consumes. Normalising here rather than in the browser keeps
// COROS's vocabulary in ONE function: when the API pack lands, normalizeWorkout
// below is the only thing that has to learn it, and the client's tested mapper
// (corosWorkoutToRun) is already correct.
type NormalWorkout = {
  key: string;
  startTime: number; // epoch ms, UTC
  staged: boolean;
  summary: {
    distanceM: number | null;
    durationSec: number | null;
    avgHr: number | null;
    maxHr: number | null;
    ascentM: number | null;
    utcOffsetMin: number | null;
    sport: "run" | "walk" | null;
  };
};

// TODO(coros-api): the single place that knows COROS's field names. Returns
// null for anything that isn't an importable run/walk. Today it can only
// return null — there is no documented shape to read, and inventing one is
// exactly the failure this scaffold exists to avoid.
function normalizeWorkout(_raw: RawWorkout, _staged = false): NormalWorkout | null {
  return null;
}

// ── OAuth (RFC 6749 standard grants; endpoint + auth style unknown) ──────────

// Error hygiene, same rule as suunto-import: surface only the HTTP status and
// the OAuth `error` code, never the request, headers or full response body —
// the catch-all at the bottom echoes the message to the client.
async function tokenRequest(params: Record<string, string>) {
  if (!API_DOCUMENTED || !TOKEN_URL) throw new Error("coros token endpoint not documented");
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept": "application/json",
  };
  const body = new URLSearchParams(params);
  if (CLIENT_AUTH_IN_BODY) {
    body.set("client_id", COROS_CLIENT_ID!);
    body.set("client_secret", COROS_CLIENT_SECRET!);
  } else {
    headers["Authorization"] = `Basic ${btoa(`${COROS_CLIENT_ID}:${COROS_CLIENT_SECRET}`)}`;
  }
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, { method: "POST", headers, body });
  } catch {
    throw new Error("coros token endpoint unreachable");
  }
  const parsed = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof parsed.error === "string" ? parsed.error : "unknown";
    const err = new Error(`coros token request failed: ${res.status} ${code}`);
    (err as Error & { oauthError?: string }).oauthError = code;
    throw err;
  }
  return parsed as { access_token?: string; refresh_token?: string; expires_in?: number; [k: string]: unknown };
}

// TODO(coros-api): how the provider-side account id arrives. Suunto reads a
// claim from the access-token JWT; Polar gets an explicit id from the token
// response. COROS's is unknown, so this reads the conventional RFC-ish spots
// and the caller treats an empty result as "not documented yet" rather than
// inventing an identifier (which would break webhook mapping and re-auth).
function externalUserIdFrom(tok: Record<string, unknown>): string {
  for (const k of ["openId", "openid", "user_id", "userId", "sub"]) {
    const v = tok[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return "";
}

// Fresh access token for the row, refreshing (and persisting the rotation) when
// needed. Concurrency-safe the same way suunto-import is: rotation is a
// compare-and-swap on the OLD refresh token, and invalid_grant re-reads before
// concluding anything, so a phone/tablet refresh race can never delete a good
// credential. A genuinely dead refresh token KEEPS the row (cursor and account
// id preserved) and flags needs_reauth. A null expires_at means NEVER EXPIRES
// (Polar-style), not "expired".
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
    const { data } = await admin.from("integration_connections")
      .select("external_user_id, access_token, refresh_token, expires_at, sync_cursor, sync_state")
      .eq("user_id", userId).eq("provider", "coros").maybeSingle();
    const current = data as ConnectionRow | null;
    if (current && current.refresh_token && current.refresh_token !== attempted) {
      return await getFreshToken(admin, userId, current, force);
    }
    await admin.from("integration_connections")
      .update({ sync_state: { ...(current?.sync_state || {}), needs_reauth: true }, updated_at: new Date().toISOString() })
      .eq("user_id", userId).eq("provider", "coros");
    return "reauth";
  }
  if (!tok.access_token) throw new Error("coros refresh returned no access token");

  const update = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || attempted,
    expires_at: new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  await admin.from("integration_connections").update(update)
    .eq("user_id", userId).eq("provider", "coros").eq("refresh_token", attempted);
  return { token: tok.access_token };
}

// TODO(coros-api): the auth style for API calls (Bearer assumed) and any extra
// app/subscription key. Never called while API_DOCUMENTED is false.
async function apiFetch(
  admin: SupabaseClient, userId: string, row: ConnectionRow, url: string, accept: string,
): Promise<Response | "reauth"> {
  let fresh = await getFreshToken(admin, userId, row);
  if (fresh === "reauth") return "reauth";
  const doFetch = (token: string) => fetch(url, {
    headers: { "Authorization": `Bearer ${token}`, "Accept": accept },
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

    // No secrets configured: the dormant answer every deploy gives today.
    if (!hasCorosCreds) return json({ skipped: "coros not configured", connected: false });

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const loadRow = async (): Promise<ConnectionRow | null> => {
      const { data } = await admin.from("integration_connections")
        .select("external_user_id, access_token, refresh_token, expires_at, sync_cursor, sync_state")
        .eq("user_id", user.id).eq("provider", "coros").maybeSingle();
      return data as ConnectionRow | null;
    };

    // ── Actions that touch only our own tables: complete and correct today ──

    if (action === "status") {
      const row = await loadRow();
      return json({ connected: !!row && !row.sync_state?.needs_reauth });
    }

    if (action === "disconnect") {
      await admin.from("integration_connections").delete()
        .eq("user_id", user.id).eq("provider", "coros");
      await admin.from("integration_staged_workouts").delete()
        .eq("user_id", user.id).eq("provider", "coros");
      return json({ ok: true });
    }

    if (action === "ack") {
      const cursor = Number(payload.cursor);
      if (Number.isFinite(cursor) && cursor > 0) {
        // Atomic greatest() — two concurrent acks can never rewind the cursor.
        await admin.rpc("ack_integration_cursor", {
          p_user_id: user.id, p_provider: "coros", p_cursor: Math.round(cursor),
        });
      }
      const stagedKeys = Array.isArray(payload.stagedKeys)
        ? (payload.stagedKeys as unknown[]).map(String).filter(Boolean) : [];
      if (stagedKeys.length) {
        await admin.from("integration_staged_workouts").delete()
          .eq("user_id", user.id).eq("provider", "coros")
          .in("external_key", stagedKeys);
      }
      return json({ ok: true });
    }

    // ── Actions that reach COROS: gated until the API pack lands ────────────

    if (!API_DOCUMENTED) return notDocumented();

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
      if (!tok.access_token) throw new Error("coros exchange returned no access token");
      const externalId = externalUserIdFrom(tok);
      if (!externalId) throw new Error("coros exchange returned no account id");
      const existing = await loadRow();
      // Same account re-authorizing (e.g. after needs_reauth): KEEP the cursor,
      // or a routine re-auth would replay the whole history. A different
      // account starts at 0 and drops the old account's staged rows, whose keys
      // would 4xx against the new token.
      const sameAccount = existing?.external_user_id === externalId;
      if (!sameAccount) {
        await admin.from("integration_staged_workouts").delete()
          .eq("user_id", user.id).eq("provider", "coros");
      }
      const { error } = await admin.from("integration_connections").upsert({
        user_id: user.id,
        provider: "coros",
        external_user_id: externalId,
        access_token: tok.access_token,
        refresh_token: tok.refresh_token ?? null,
        expires_at: tok.expires_in ? new Date(Date.now() + Number(tok.expires_in) * 1000).toISOString() : null,
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
      // the app never drained — the since-cursor list still covers them.
      await admin.from("integration_staged_workouts").delete()
        .eq("user_id", user.id).eq("provider", "coros")
        .lt("created_at", new Date(Date.now() - STAGED_TTL_MS).toISOString());
      const { data: stagedRows } = await admin.from("integration_staged_workouts")
        .select("external_key, payload")
        .eq("user_id", user.id).eq("provider", "coros");
      const staged = (stagedRows || []) as { external_key: string; payload: RawWorkout | null }[];

      const listRes = await apiFetch(admin, user.id, row, LIST_PATH(row.sync_cursor, LIST_LIMIT), "application/json");
      if (listRes === "reauth") return json({ connected: false, reauth: true, workouts: [] });
      if (!listRes.ok) throw new Error(`coros workout list failed: ${listRes.status}`);
      const listBody = await listRes.json().catch(() => ({})) as Record<string, unknown>;
      // TODO(coros-api): the response envelope. Accepts the shapes vendors
      // commonly use so a wrapper name is not itself a guess to get wrong.
      const listedRaw = Array.isArray(listBody.data) ? listBody.data
        : Array.isArray(listBody.workouts) ? listBody.workouts
        : Array.isArray(listBody) ? listBody as unknown[] : [];

      // Walk ascending. The returned cursor covers every walked workout,
      // INCLUDING deliberately-skipped ones (wrong sport, already known) —
      // otherwise a run of 100 cycling workouts would wedge the watermark. It
      // is start-time based WITHOUT a +1 (equal-startTime workouts split across
      // a page boundary re-list once; knownKeys absorbs that), and the client
      // only acks it after the runs are saved.
      const normalized = (listedRaw as RawWorkout[])
        .map(w => normalizeWorkout(w))
        .filter((w): w is NormalWorkout => !!w && !!w.key)
        .sort((a, b) => a.startTime - b.startTime);

      const listedKeys = new Set<string>();
      const workouts: NormalWorkout[] = [];
      let cursor = row.sync_cursor;
      let truncated = false;
      for (const w of normalized) {
        if (workouts.length >= pageSize) { truncated = true; break; }
        listedKeys.add(w.key);
        cursor = Math.max(cursor, w.startTime);
        if (knownKeys.has(w.key)) continue;
        workouts.push(w);
      }
      // Skipped-because-unrecognised is counted, not silent: a sport id we
      // don't know yet must show up in the logs, not as "no new runs".
      const skipped = listedRaw.length - normalized.length;
      if (skipped > 0) console.log("coros-import skipped unrecognised workouts", skipped);

      // Staged workouts the list walk didn't already cover. Known/filtered ones
      // still return their keys so ack can drain them.
      const stagedKeys: string[] = [];
      for (const s of staged) {
        stagedKeys.push(s.external_key);
        if (listedKeys.has(s.external_key) || knownKeys.has(s.external_key)) continue;
        const w = normalizeWorkout(s.payload || {}, true);
        if (w) workouts.push({ ...w, key: s.external_key, staged: true });
      }

      // Counts only, never workout data. "Nothing imported" has several very
      // different causes — the list came back empty (cursor past everything, or
      // a wrong `since` unit), everything was filtered, or the client already
      // knew it all — and they are indistinguishable from the client.
      console.log(`coros-import sync since=${row.sync_cursor} listed=${listedRaw.length} offered=${workouts.length} staged=${staged.length} known=${knownKeys.size}`);

      return json({
        connected: true,
        workouts,
        cursor,
        stagedKeys,
        hasMore: truncated || listedRaw.length >= LIST_LIMIT,
      });
    }

    if (action === "file") {
      const key = typeof payload.key === "string" ? payload.key : "";
      if (!key) return json({ error: "key is required" }, 400);
      const row = await loadRow();
      if (!row) return json({ connected: false, transient: true });
      // Per-user daily cap: downloads spend an app-wide metered quota, so one
      // runaway client must not burn it for everyone. Over-cap is TRANSIENT
      // (tomorrow's scan resumes), never a summary-only fallback.
      const { data: count } = await admin.rpc("increment_integration_sync_usage", {
        p_user_id: user.id, p_provider: "coros", p_day: new Date().toISOString().slice(0, 10),
      });
      if (typeof count === "number" && count > FILE_DAILY_LIMIT) {
        return json({ connected: true, transient: true, quota: true });
      }
      let res: Response | "reauth";
      try {
        res = await apiFetch(admin, user.id, row, `${API}${FILE_PATH(key)}`, "application/octet-stream");
      } catch {
        return json({ connected: true, transient: true }); // network — retry next scan
      }
      if (res === "reauth") return json({ connected: false, reauth: true, transient: true });
      if (res.ok) return json({ connected: true, file: b64(new Uint8Array(await res.arrayBuffer())) });
      // Only a hard "this workout has no file" is terminal (the client then
      // imports the summary). Everything else is transient: marking it terminal
      // would permanently import route-less runs, which is exactly the failure
      // that shipped for Suunto and took two PRs to find, because from the app
      // it looks like a run with no map rather than like an endpoint error.
      //
      // Logged as status only — never the key, the body or a header.
      if (res.status === 404 || res.status === 410) {
        console.warn("coros-import file missing", res.status);
        return json({ connected: true, gone: true });
      }
      console.error("coros-import file failed", res.status);
      return json({ connected: true, transient: true, status: res.status });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    console.error("coros-import error", err instanceof Error ? err.message : String(err));
    return json({ error: err instanceof Error ? err.message : String(err) }, 200); // never hard-fail the caller's scan
  }
});
