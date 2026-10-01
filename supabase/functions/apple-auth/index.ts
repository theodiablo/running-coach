// apple-auth — stores and revokes Sign in with Apple grants (guideline 5.1.1(v)).
// Actions, flows and secrets: docs/release.md ("Sign in with Apple").

import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { appleClientSecret, jwtClaims } from "../_shared/appleAuth.mjs";

const TEAM_ID = Deno.env.get("APPLE_TEAM_ID");
const KEY_ID = Deno.env.get("APPLE_KEY_ID");
const PRIVATE_KEY = Deno.env.get("APPLE_PRIVATE_KEY");
const SERVICES_ID = Deno.env.get("APPLE_SERVICES_ID");
const BUNDLE_ID = Deno.env.get("APPLE_BUNDLE_ID") ?? "solutions.camboulive.run";
const configured = Boolean(TEAM_ID && KEY_ID && PRIVATE_KEY);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Apple's codes and tokens are short dotted base64url-ish strings; anything else
// is refused before it costs a signed request to Apple.
const TOKEN_SHAPE = /^[A-Za-z0-9._-]{1,2048}$/;
const tokenParam = (v: unknown) => (typeof v === "string" && TOKEN_SHAPE.test(v) ? v : null);

// A failure the caller caused (Apple refused the grant) vs. one on our side.
class AppleRejected extends Error {}

const secretFor = (clientId: string) =>
  appleClientSecret({ teamId: TEAM_ID, keyId: KEY_ID, privateKeyPem: PRIVATE_KEY, clientId });

type AppleTokenResponse = { refresh_token?: string; id_token?: string };

async function appleToken(clientId: string, params: Record<string, string>): Promise<AppleTokenResponse> {
  const res = await fetch("https://appleid.apple.com/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: await secretFor(clientId), ...params }),
  });
  if (res.ok) return await res.json();
  const detail = `apple token ${params.grant_type} failed: ${res.status} ${await res.text()}`;
  throw res.status === 400 ? new AppleRejected(detail) : new Error(detail);
}

async function appleRevoke(clientId: string, refreshToken: string): Promise<boolean> {
  const res = await fetch("https://appleid.apple.com/auth/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: await secretFor(clientId),
      token: refreshToken,
      token_type_hint: "refresh_token",
    }),
  });
  if (!res.ok) console.error("apple revoke failed", res.status, await res.text());
  return res.ok;
}

// The native sheet's one-time code, exchanged under the bundle id.
async function exchangeCode(code: string) {
  const tok = await appleToken(BUNDLE_ID, { grant_type: "authorization_code", code });
  if (!tok.refresh_token) throw new Error("apple returned no refresh token");
  return { clientId: BUNDLE_ID, refreshToken: tok.refresh_token, idToken: tok.id_token };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const payload = await req.json().catch(() => ({})) as Record<string, unknown>;

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

    if (!configured) return json({ skipped: "apple not configured" });

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const appleSub = user.identities?.find((i) => i.provider === "apple")?.identity_data?.sub;
    const ownedByCaller = (idToken?: string) => Boolean(appleSub) && jwtClaims(idToken)?.sub === appleSub;
    const code = tokenParam(payload.authorizationCode);

    if (payload.action === "store") {
      if (!appleSub) return json({ error: "no apple identity" }, 400);
      const refreshParam = tokenParam(payload.refreshToken);

      let grant: { clientId: string; refreshToken: string; idToken?: string };
      if (code) {
        grant = await exchangeCode(code);
      } else if (refreshParam) {
        if (!SERVICES_ID) return json({ skipped: "services id not configured" });
        // Apple throttles refresh-token validation, so an unchanged grant is a no-op.
        const { data: existing } = await admin.from("apple_auth_grants").select("refresh_token")
          .eq("user_id", user.id).eq("client_id", SERVICES_ID).maybeSingle();
        if (existing?.refresh_token === refreshParam) return json({ stored: true });
        const { id_token } = await appleToken(SERVICES_ID, { grant_type: "refresh_token", refresh_token: refreshParam });
        grant = { clientId: SERVICES_ID, refreshToken: refreshParam, idToken: id_token };
      } else {
        return json({ error: "authorizationCode or refreshToken required" }, 400);
      }

      if (!ownedByCaller(grant.idToken)) return json({ error: "grant does not match the apple identity" }, 403);

      const { error } = await admin.from("apple_auth_grants").upsert({
        user_id: user.id,
        client_id: grant.clientId,
        refresh_token: grant.refreshToken,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      return json({ stored: true });
    }

    if (payload.action === "revoke") {
      const { data: rows, error } = await admin.from("apple_auth_grants")
        .select("client_id, refresh_token").eq("user_id", user.id);
      if (error) throw error;
      const grants = (rows ?? []).map((r) => ({ clientId: r.client_id as string, refreshToken: r.refresh_token as string }));
      // No stored grant: a fresh code from the deletion flow is exchanged and revoked at once.
      if (!grants.length && code) {
        const fresh = await exchangeCode(code);
        if (!ownedByCaller(fresh.idToken)) return json({ error: "grant does not match the apple identity" }, 403);
        grants.push(fresh);
      }
      let revoked = 0;
      for (const g of grants) {
        if (!(await appleRevoke(g.clientId, g.refreshToken))) continue;
        revoked++;
        await admin.from("apple_auth_grants").delete().eq("user_id", user.id).eq("client_id", g.clientId);
      }
      if (revoked < grants.length) console.error("apple-auth: revoked", revoked, "of", grants.length, "for", user.id);
      return json({ revoked, total: grants.length });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    console.error("apple-auth error", err);
    if (err instanceof AppleRejected) return json({ error: "apple rejected the grant" }, 400);
    return json({ error: "apple-auth failed" }, 502);
  }
});
