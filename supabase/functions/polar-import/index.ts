// polar-import — server side of the Polar (AccessLink) cloud import: holds the
// OAuth secret and the user's token, never returned to the client. Actions:
// status, exchange, sync, disconnect. Can't be exercised in CI (live Polar
// cloud) — verify end-to-end after registering a Polar app.
// Architecture, actions, deploy/secrets: docs/integrations-polar.md.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const POLAR_CLIENT_ID = Deno.env.get("POLAR_CLIENT_ID");
const POLAR_CLIENT_SECRET = Deno.env.get("POLAR_CLIENT_SECRET");
const hasPolarCreds = Boolean(POLAR_CLIENT_ID && POLAR_CLIENT_SECRET);

const TOKEN_URL = "https://polarremote.com/v2/oauth2/token";
const API = "https://www.polaraccesslink.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ── Polar AccessLink calls ─────────────────────────────────────────────────

// Exchange an authorization code for a long-lived access token (+ x_user_id).
// codeVerifier is the client's PKCE verifier (cloudOauth.ts) — forwarded when
// present; Polar ignores it if unsupported (RFC 6749 requires that).
async function exchangeCode(code: string, redirectUri: string, codeVerifier?: string) {
  const basic = btoa(`${POLAR_CLIENT_ID}:${POLAR_CLIENT_SECRET}`);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    }),
  });
  if (!res.ok) throw new Error(`polar token exchange failed: ${res.status}`);
  return await res.json() as { access_token: string; x_user_id?: number };
}

// Register the authenticated user with AccessLink (required once before pulling
// data). A 409 means already registered — not an error. member-id just has to be
// a stable per-user string; we use the Supabase user id.
async function registerUser(token: string, memberId: string, xUserId?: number): Promise<string> {
  const res = await fetch(`${API}/v3/users`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ "member-id": memberId }),
  });
  if (res.ok) {
    const body = await res.json() as { "polar-user-id"?: number };
    if (body["polar-user-id"] != null) return String(body["polar-user-id"]);
  } else if (res.status !== 409) {
    throw new Error(`polar user registration failed: ${res.status} ${await res.text()}`);
  }
  // Already registered (409) or no id in the body: fall back to x_user_id from
  // the token response, which is the same AccessLink user id.
  if (xUserId != null) return String(xUserId);
  throw new Error("polar user id unavailable after registration");
}

type PolarExercise = { id: string; summary: unknown; gpx: string | null };

// One exercise's summary + GPX (route + HR extensions). Three outcomes:
//   - a PolarExercise      → fetched OK (GPX 404 for an indoor run → gpx:null,
//                            still importable from the summary).
//   - "retry"              → a TRANSIENT failure (network / 5xx) worth retrying
//                            next sync; the caller must NOT commit the transaction.
//   - null                 → a TERMINAL, non-retryable exercise (4xx gone, or a
//                            malformed / id-less summary). Skip it, but it must
//                            NOT block the commit — otherwise one bad exercise
//                            wedges the whole transaction forever.
async function fetchExercise(token: string, uri: string): Promise<PolarExercise | null | "retry"> {
  const auth = { "Authorization": `Bearer ${token}` };
  let summaryRes: Response;
  try {
    summaryRes = await fetch(uri, { headers: { ...auth, "Accept": "application/json" } });
  } catch {
    return "retry"; // network error — retryable
  }
  if (summaryRes.status >= 500) return "retry"; // server error — retryable
  // 401/403 = the stored token was revoked or expired mid-sync. This is NOT an
  // "exercise gone" — treat it as retryable so the transaction is left OPEN and
  // the exercises aren't dropped when the user reconnects. Lumping it with 404
  // would commit past unfetched runs and lose them permanently.
  if (summaryRes.status === 401 || summaryRes.status === 403) return "retry";
  if (!summaryRes.ok) return null;              // other 4xx (e.g. gone) — terminal, skip
  const summary = await summaryRes.json().catch(() => null);
  const id = summary ? String((summary as { id?: unknown }).id ?? "") : "";
  if (!id) return null;                          // malformed / id-less — terminal, skip
  let gpx: string | null = null;
  try {
    const gpxRes = await fetch(`${uri}/gpx`, { headers: { ...auth, "Accept": "application/gpx+xml" } });
    if (gpxRes.ok) gpx = await gpxRes.text();   // 404 = no route (fine); else summary-only
  } catch { /* no route — summary-only */ }
  return { id, summary, gpx };
}

// Pull all not-yet-transacted exercises via the AccessLink transaction lifecycle:
// create → list → fetch each → commit (advances Polar's "new" cursor). 204 on
// create means nothing new. Client-side extId dedupe is the safety net if a
// commit lands but the client save doesn't.
async function pullExercises(token: string, polarUserId: string) {
  const base = `${API}/v3/users/${polarUserId}/exercise-transactions`;
  const auth = { "Authorization": `Bearer ${token}` };
  const createRes = await fetch(base, { method: "POST", headers: { ...auth, "Accept": "application/json" } });
  if (createRes.status === 204) return []; // no new data
  if (!createRes.ok) throw new Error(`polar transaction create failed: ${createRes.status} ${await createRes.text()}`);
  const created = await createRes.json() as { "transaction-id"?: number | string };
  const txId = created["transaction-id"];
  if (txId == null) return [];
  const txUrl = `${base}/${txId}`;

  const listRes = await fetch(txUrl, { headers: { ...auth, "Accept": "application/json" } });
  // If the LIST fails, do NOT commit — that would advance Polar's cursor past
  // exercises we never fetched, losing them forever. Leave the transaction open;
  // the next sync re-creates it with the same exercises.
  if (!listRes.ok) return [];
  const list = await listRes.json() as { exercises?: string[] };
  const uris = Array.isArray(list.exercises) ? list.exercises : [];

  const exercises: PolarExercise[] = [];
  let anyRetryable = false;
  for (const uri of uris) {
    const ex = await fetchExercise(token, uri);
    if (ex === "retry") { anyRetryable = true; continue; } // transient — try again next sync
    if (ex && ex.id) exercises.push(ex);
    // else (null): terminal-unusable (gone / malformed) — skip, but do NOT treat
    // it as a reason to hold the transaction open.
  }
  // Advance Polar's "new" cursor UNLESS a transient failure means a retry could
  // still surface more. Terminal-bad exercises are deliberately not a reason to
  // hold the transaction open — that would re-list the whole set every sync
  // forever and let one bad exercise wedge all the good ones. Client-side extId
  // dedupe drops anything already saved, so committing after a clean pass is safe.
  if (!anyRetryable) await fetch(txUrl, { method: "PUT", headers: auth }).catch(() => {});
  return exercises;
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

    if (!hasPolarCreds) return json({ skipped: "polar not configured", connected: false });

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Credentials live in the generic integration_connections table
    // (provider = 'polar').
    const loadToken = async () => {
      const { data } = await admin.from("integration_connections")
        .select("external_user_id, access_token")
        .eq("user_id", user.id).eq("provider", "polar").maybeSingle();
      if (!data) return null;
      const row = data as { external_user_id: string; access_token: string };
      return { polar_user_id: row.external_user_id, access_token: row.access_token };
    };

    if (action === "status") {
      return json({ connected: !!(await loadToken()) });
    }

    if (action === "disconnect") {
      await admin.from("integration_connections").delete()
        .eq("user_id", user.id).eq("provider", "polar");
      return json({ ok: true });
    }

    if (action === "exchange") {
      const code = typeof payload.code === "string" ? payload.code : "";
      const redirectUri = typeof payload.redirectUri === "string" ? payload.redirectUri : "";
      const codeVerifier = typeof payload.codeVerifier === "string" ? payload.codeVerifier : undefined;
      if (!code || !redirectUri) return json({ error: "code and redirectUri are required" }, 400);
      const tok = await exchangeCode(code, redirectUri, codeVerifier);
      const polarUserId = await registerUser(tok.access_token, user.id, tok.x_user_id);
      const { error } = await admin.from("integration_connections").upsert({
        user_id: user.id,
        provider: "polar",
        external_user_id: polarUserId,
        access_token: tok.access_token,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      return json({ connected: true });
    }

    if (action === "sync") {
      const token = await loadToken();
      if (!token) return json({ exercises: [], connected: false });
      const exercises = await pullExercises(token.access_token, token.polar_user_id);
      return json({ exercises, connected: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    console.error("polar-import error", err);
    return json({ error: String(err) }, 200); // never hard-fail the caller's scan
  }
});
