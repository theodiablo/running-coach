// coros-import — server side of the COROS cloud import: holds the OAuth secret
// and the user's tokens, never returned to the client. Actions: status,
// exchange, sync (one 30-day page of workout summaries), file (one .fit),
// ack (advance the cursor + drain staged rows), disconnect.
//
// Calibrated against the COROS API Reference V2.0.6 (February 2026); every
// endpoint and field cites a section of it. UNVERIFIED against a live account —
// dormant until COROS_CLIENT_ID/COROS_CLIENT_SECRET are set, and the first live
// pass should be read against docs/integrations-coros.md.
//
// COROS differs from Suunto in three ways that shape this whole file:
//
//   1. THE LIST IS A DATE RANGE, NOT A CURSOR (§4.2). `GET /v2/coros/sport/list`
//      takes startDate/endDate as YYYYMMDD, spans at most 30 days per call, and
//      REFUSES any start earlier than three months before today. There is no
//      full-history backfill to be had: the reachable past is a rolling ~3-month
//      window. We keep our own epoch-ms watermark in `sync_cursor` and walk it
//      forward 30 days at a time, clamped to that floor.
//   2. THE LISTING HAS NO HEART RATE AND NO ELEVATION (§4.2.4). It carries
//      distance, duration, start/end time, timezone, sport, cadence, calories
//      and a direct `fitUrl`. HR and elevation exist only inside the .fit.
//   3. REFRESH DOES NOT ROTATE THE TOKEN (§3.3). `POST /oauth2/refresh-token`
//      answers `{result, message}` and nothing else — it EXTENDS the existing
//      accessToken by 30 days. Expecting a new token here would throw on every
//      refresh. The refresh token itself never expires.
//
// Auth style is COROS's own, not a bearer header: data calls take `?token=` and
// `?openId=` as query parameters (§4.1-4.3), and the token endpoints take
// client_id/client_secret in the form body (§3.2.2), not HTTP Basic.
//
// Responses are HTTP 200 with a result code in the body: "0000" is success
// (§8.1.3). A non-0000 result is a failure however healthy the status line.
//
// The sync protocol is OURS, the one Suunto proved: cursor + deferred ack. sync
// never advances the cursor; the client acks only after runs are saved, so an
// unacked page is re-served and a missed toast never loses history.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const COROS_CLIENT_ID = Deno.env.get("COROS_CLIENT_ID");
const COROS_CLIENT_SECRET = Deno.env.get("COROS_CLIENT_SECRET");
const hasCorosCreds = Boolean(COROS_CLIENT_ID && COROS_CLIENT_SECRET);

// §1.1: production is open.coros.com, the sandbox opentest.coros.com. Set
// COROS_API_BASE to the sandbox while verifying against test credentials.
const API = Deno.env.get("COROS_API_BASE") || "https://open.coros.com";
const TOKEN_URL = `${API}/oauth2/accesstoken`;        // §3.2.2
const REFRESH_URL = `${API}/oauth2/refresh-token`;    // §3.3.2
const DEAUTH_URL = `${API}/oauth2/deauthorize`;       // §3.4.2
const BIND_STATE_URL = `${API}/coros/bindState`;      // §3.5.2
const LIST_URL = `${API}/v2/coros/sport/list`;        // §4.2.2

// §4.2.4 workout type table, as mode/subMode pairs.
const RUN_SPORTS = new Set(["8/1" /* Outdoor Run */, "8/2" /* Indoor Run */, "15/1" /* Trail Run */, "20/1" /* Track Run */]);
const WALK_SPORTS = new Set(["31/1" /* Walk */, "16/1" /* Hike */]);

const DAY_MS = 24 * 3600_000;
// §4.2.1: at most 30 days per query.
const WINDOW_MS = 30 * DAY_MS;
// §4.2.1 / revision V2.5: nothing earlier than three months before today. The
// shortest calendar three-month span is 90 days, so 88 stays safely inside it
// whatever the month and whatever timezone COROS resolves "today" in.
const HISTORY_FLOOR_MS = 88 * DAY_MS;
// §3.2.1 / §3.3.1: the access token lasts 30 days and refresh extends it by 30.
const TOKEN_TTL_MS = 30 * DAY_MS;
// Refresh once inside a day of expiry — the token is good for a month, so there
// is no value in cutting it finer.
const REFRESH_MARGIN_MS = DAY_MS;
const PAGE_MAX = 50;
const STAGED_TTL_MS = 30 * DAY_MS;
const FILE_DAILY_LIMIT = Number(Deno.env.get("COROS_FILE_DAILY_LIMIT") || 300);
const OK = "0000";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type ConnectionRow = {
  external_user_id: string; // COROS openId (§3.2.4)
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  sync_cursor: number;
  sync_state: Record<string, unknown> | null;
};

type RawWorkout = Record<string, unknown>;

type NormalWorkout = {
  key: string;
  startTime: number; // epoch ms, UTC
  staged: boolean;
  fitUrl: string | null;
  summary: {
    distanceM: number | null;
    durationSec: number | null;
    utcOffsetMin: number | null;
    sport: "run" | "walk" | null;
  };
};

const numOf = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// The one place that knows COROS's field names and units (§4.2.4). Returns null
// for anything that isn't an importable run or walk, so non-run activities are
// dropped BEFORE their .fit is ever downloaded. The same shape arrives from the
// listing and from the summary push (§5.3.3), so one function serves both.
function normalizeWorkout(raw: RawWorkout, staged = false): NormalWorkout | null {
  const key = raw.labelId != null ? String(raw.labelId) : "";
  if (!key) return null;
  const mode = numOf(raw.mode);
  const subMode = numOf(raw.subMode);
  const pair = `${mode}/${subMode}`;
  const sport = RUN_SPORTS.has(pair) ? "run" as const : WALK_SPORTS.has(pair) ? "walk" as const : null;
  if (!sport) return null;
  // §4.2.4: startTime is an epoch in SECONDS; startTimezone is in 15-minute
  // units (32 means UTC+08:00), so the local offset is tz * 15 minutes.
  const startSec = numOf(raw.startTime);
  if (!startSec) return null;
  const tz = numOf(raw.startTimezone);
  const fitUrl = typeof raw.fitUrl === "string" && raw.fitUrl ? raw.fitUrl : null;
  const start = numOf(raw.startTime) || 0;
  const end = numOf(raw.endTime);
  return {
    key,
    startTime: startSec * 1000,
    staged,
    fitUrl,
    summary: {
      distanceM: numOf(raw.distance),
      // §4.2.4 lists `duration` on the triathlon legs; the top-level workout
      // carries it too (see the §4.2 example). Fall back to end - start.
      durationSec: numOf(raw.duration) ?? (end != null ? Math.max(0, end - start) : null),
      utcOffsetMin: tz != null ? tz * 15 : null,
      sport,
    },
  };
}

// COROS answers 200 with a result code in the body (§8.1.3). Anything but
// "0000" is a failure, and 429 is the documented rate-limit signal (Addendum).
type CorosBody = { result?: string; message?: string; data?: unknown };
const isOk = (b: CorosBody) => b?.result === OK;

const form = (params: Record<string, string>) => new URLSearchParams(params);

async function postForm(url: string, params: Record<string, string>): Promise<CorosBody> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: form(params),
    });
  } catch {
    throw new Error("coros endpoint unreachable");
  }
  const body = await res.json().catch(() => ({})) as CorosBody & Record<string, unknown>;
  if (!res.ok) throw new Error(`coros request failed: ${res.status}`);
  return body;
}

// §3.2.4: the JSON example returns snake_case (access_token, refresh_token,
// expires_in) while the parameter table names camelCase. Read both rather than
// betting on which the live service emits.
const pick = (b: Record<string, unknown>, ...names: string[]): string => {
  for (const n of names) {
    const v = b[n];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return "";
};

// Fresh access token for the row. COROS's refresh EXTENDS the existing token
// rather than issuing a new one (§3.3.1), so there is no rotation to race and
// no compare-and-swap to do — only the stored expiry moves. A refresh that
// COROS rejects means the user revoked access: keep the row (openId and cursor
// intact) and flag needs_reauth.
async function getFreshToken(
  admin: SupabaseClient, userId: string, row: ConnectionRow, force = false,
): Promise<{ token: string } | "reauth"> {
  if (!row.refresh_token || !row.expires_at) return { token: row.access_token };
  const msLeft = Date.parse(row.expires_at) - Date.now();
  if (!force && msLeft > REFRESH_MARGIN_MS) return { token: row.access_token };

  let body: CorosBody;
  try {
    body = await postForm(REFRESH_URL, {
      client_id: COROS_CLIENT_ID!,
      client_secret: COROS_CLIENT_SECRET!,
      refresh_token: row.refresh_token,
      grant_type: "refresh_token",
    });
  } catch {
    // Network trouble is not a revoked grant — keep the token and let the
    // caller's request fail transiently instead of flagging a reauth.
    return { token: row.access_token };
  }
  if (!isOk(body)) {
    console.warn("coros-import refresh rejected", body?.result || "unknown");
    await admin.from("integration_connections")
      .update({ sync_state: { ...(row.sync_state || {}), needs_reauth: true }, updated_at: new Date().toISOString() })
      .eq("user_id", userId).eq("provider", "coros");
    return "reauth";
  }
  await admin.from("integration_connections")
    .update({ expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString(), updated_at: new Date().toISOString() })
    .eq("user_id", userId).eq("provider", "coros");
  return { token: row.access_token };
}

// §4.x: data calls carry the token and openId as QUERY parameters, not headers.
async function apiGet(
  admin: SupabaseClient, userId: string, row: ConnectionRow, path: string, params: Record<string, string>,
): Promise<CorosBody | "reauth"> {
  const fresh = await getFreshToken(admin, userId, row);
  if (fresh === "reauth") return "reauth";
  const url = new URL(path);
  url.searchParams.set("token", fresh.token);
  url.searchParams.set("openId", row.external_user_id);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: { "Accept": "application/json" } });
  if (res.status === 429) throw new Error("coros rate limited: 429");
  if (!res.ok) throw new Error(`coros request failed: ${res.status}`);
  return await res.json().catch(() => ({})) as CorosBody;
}

// §4.2.3: dates are plain YYYYMMDD integers. Resolved in UTC — COROS does not
// say which clock it reads them in, and the window overlaps enough (the client
// re-lists from its own watermark) that a day of slack cannot lose a workout.
const yyyymmdd = (ms: number): string => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

// The .fit lives on COROS's object storage, and its URL arrives from the
// listing rather than being constructed (§4.2.4). The client hands it back on
// the `file` call, so it is UNTRUSTED INPUT: only https on a coros.com host is
// ever fetched, or this action would be an open proxy into our network.
function isAllowedFitUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    return u.hostname === "coros.com" || u.hostname.endsWith(".coros.com");
  } catch { return false; }
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

    if (action === "status") {
      const row = await loadRow();
      if (!row || row.sync_state?.needs_reauth) return json({ connected: false });
      // §3.5.1 recommends checking bindState when the user opens the
      // integrations list: a user who unbound us inside the COROS app leaves
      // our row untouched, and without this the row would claim "connected"
      // forever. A failed check falls back to the row rather than logging the
      // user out on a blip.
      try {
        const res = await apiGet(admin, user.id, row, BIND_STATE_URL, {});
        if (res !== "reauth" && isOk(res)) {
          const bound = (res.data as { bindState?: number } | null)?.bindState;
          if (bound === 0) return json({ connected: false, unbound: true });
        }
      } catch { /* keep the row's answer */ }
      return json({ connected: true });
    }

    if (action === "disconnect") {
      const row = await loadRow();
      // §3.4: tell COROS first, so the user's authorization list matches what
      // the app shows. Best effort — a failure here must not strand the row.
      if (row) {
        try {
          await fetch(`${DEAUTH_URL}?token=${encodeURIComponent(row.access_token)}`, {
            method: "POST",
            headers: { "token": row.access_token, "Accept": "application/json" },
          });
        } catch { /* local disconnect still proceeds */ }
      }
      await admin.from("integration_connections").delete()
        .eq("user_id", user.id).eq("provider", "coros");
      await admin.from("integration_staged_workouts").delete()
        .eq("user_id", user.id).eq("provider", "coros");
      return json({ ok: true });
    }

    if (action === "ack") {
      const cursor = Number(payload.cursor);
      if (Number.isFinite(cursor) && cursor > 0) {
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

    if (action === "exchange") {
      const code = typeof payload.code === "string" ? payload.code : "";
      const redirectUri = typeof payload.redirectUri === "string" ? payload.redirectUri : "";
      if (!code || !redirectUri) return json({ error: "code and redirectUri are required" }, 400);
      // §3.2.2: client_id and client_secret go in the FORM BODY, not Basic auth.
      const tok = await postForm(TOKEN_URL, {
        client_id: COROS_CLIENT_ID!,
        client_secret: COROS_CLIENT_SECRET!,
        redirect_uri: redirectUri,
        code,
        grant_type: "authorization_code",
      }) as Record<string, unknown>;
      const accessToken = pick(tok, "access_token", "accessToken");
      const refreshToken = pick(tok, "refresh_token", "refreshToken");
      const openId = pick(tok, "openId", "openid", "open_id");
      if (!accessToken) throw new Error("coros exchange returned no access token");
      if (!openId) throw new Error("coros exchange returned no openId");
      const expiresIn = Number(pick(tok, "expires_in", "expiresIn")) || TOKEN_TTL_MS / 1000;
      const existing = await loadRow();
      // Same account re-authorizing keeps the cursor; a different one starts
      // over and drops the old account's staged rows.
      const sameAccount = existing?.external_user_id === openId;
      if (!sameAccount) {
        await admin.from("integration_staged_workouts").delete()
          .eq("user_id", user.id).eq("provider", "coros");
      }
      const { error } = await admin.from("integration_connections").upsert({
        user_id: user.id,
        provider: "coros",
        external_user_id: openId,
        access_token: accessToken,
        refresh_token: refreshToken || null,
        expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
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

      await admin.from("integration_staged_workouts").delete()
        .eq("user_id", user.id).eq("provider", "coros")
        .lt("created_at", new Date(Date.now() - STAGED_TTL_MS).toISOString());
      const { data: stagedRows } = await admin.from("integration_staged_workouts")
        .select("external_key, payload")
        .eq("user_id", user.id).eq("provider", "coros");
      const staged = (stagedRows || []) as { external_key: string; payload: RawWorkout | null }[];

      // Walk the reachable window forward. The floor is COROS's three-month
      // limit, so a first connect starts there rather than at the epoch — there
      // is no older history to ask for, and asking would be rejected outright.
      const now = Date.now();
      const floor = now - HISTORY_FLOOR_MS;
      const from = Math.max(row.sync_cursor || 0, floor);
      const to = Math.min(from + WINDOW_MS, now);

      const res = await apiGet(admin, user.id, row, LIST_URL, {
        startDate: yyyymmdd(from),
        endDate: yyyymmdd(to),
      });
      if (res === "reauth") return json({ connected: false, reauth: true, workouts: [] });
      if (!isOk(res)) throw new Error(`coros workout list failed: ${res?.result || "unknown"}`);
      const listedRaw = Array.isArray(res.data) ? res.data as RawWorkout[] : [];

      const normalized = listedRaw
        .map(w => normalizeWorkout(w))
        .filter((w): w is NormalWorkout => !!w)
        .sort((a, b) => a.startTime - b.startTime);

      const listedKeys = new Set<string>();
      const workouts: NormalWorkout[] = [];
      // An empty or fully-filtered window MUST still advance, or the scan would
      // re-ask the same 30 days forever. The window end is the watermark when
      // every workout in it was walked.
      let cursor = row.sync_cursor;
      let truncated = false;
      for (const w of normalized) {
        if (workouts.length >= pageSize) { truncated = true; break; }
        listedKeys.add(w.key);
        cursor = Math.max(cursor, w.startTime);
        if (knownKeys.has(w.key)) continue;
        workouts.push(w);
      }
      if (!truncated) cursor = Math.max(cursor, to);

      const skipped = listedRaw.length - normalized.length;
      if (skipped > 0) console.log("coros-import skipped non-run workouts", skipped);

      const stagedKeys: string[] = [];
      for (const s of staged) {
        stagedKeys.push(s.external_key);
        if (listedKeys.has(s.external_key) || knownKeys.has(s.external_key)) continue;
        const w = normalizeWorkout(s.payload || {}, true);
        if (w) workouts.push({ ...w, key: s.external_key, staged: true });
      }

      // Counts only, never workout data. "Nothing imported" has several very
      // different causes — an empty window, everything filtered as non-run, or
      // the client already knew it all — and they look identical from the app.
      console.log(`coros-import sync ${yyyymmdd(from)}..${yyyymmdd(to)} listed=${listedRaw.length} offered=${workouts.length} staged=${staged.length} known=${knownKeys.size}`);

      return json({
        connected: true,
        workouts,
        cursor,
        stagedKeys,
        // More reachable history behind this 30-day window.
        hasMore: truncated || to < now,
      });
    }

    if (action === "file") {
      const key = typeof payload.key === "string" ? payload.key : "";
      const fitUrl = typeof payload.fitUrl === "string" ? payload.fitUrl : "";
      if (!key || !fitUrl) return json({ error: "key and fitUrl are required" }, 400);
      // Client-supplied URL: refuse anything that is not COROS over https.
      if (!isAllowedFitUrl(fitUrl)) {
        console.error("coros-import rejected fit url host");
        return json({ connected: true, gone: true });
      }
      const row = await loadRow();
      if (!row) return json({ connected: false, transient: true });
      const { data: count } = await admin.rpc("increment_integration_sync_usage", {
        p_user_id: user.id, p_provider: "coros", p_day: new Date().toISOString().slice(0, 10),
      });
      if (typeof count === "number" && count > FILE_DAILY_LIMIT) {
        return json({ connected: true, transient: true, quota: true });
      }
      let res: Response;
      try {
        // The fitUrl is object storage, already scoped by its own path — it
        // takes no token (§4.2.4).
        res = await fetch(fitUrl, { headers: { "Accept": "application/octet-stream" } });
      } catch {
        return json({ connected: true, transient: true }); // network — retry next scan
      }
      if (res.ok) return json({ connected: true, file: b64(new Uint8Array(await res.arrayBuffer())) });
      // Only a hard miss is terminal (the client then imports the summary,
      // which for COROS means no HR and no route). Everything else is transient:
      // marking it terminal would permanently import degraded runs, the exact
      // failure that shipped for Suunto and took two PRs to find.
      if (res.status === 404 || res.status === 410) {
        console.warn("coros-import fit missing", res.status);
        return json({ connected: true, gone: true });
      }
      console.error("coros-import fit failed", res.status);
      return json({ connected: true, transient: true, status: res.status });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    console.error("coros-import error", err instanceof Error ? err.message : String(err));
    return json({ error: err instanceof Error ? err.message : String(err) }, 200); // never hard-fail the caller's scan
  }
});
