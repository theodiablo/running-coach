// apple-auth — keeps each user's Sign in with Apple grant so account deletion
// can revoke it (App Store guideline 5.1.1(v)). Actions:
//   store  — { authorizationCode } from the native sheet (exchanged under the
//            bundle id) or { refreshToken } from the browser flow (validated
//            under the Services ID). Either must belong to the caller's Apple
//            identity before it is kept.
//   revoke — revokes every stored grant for the caller; called just before
//            delete_my_account.
// Setup + secrets: docs/release.md ("Sign in with Apple").

import { createClient } from "npm:@supabase/supabase-js@2";
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

const secretFor = (clientId: string) =>
  appleClientSecret({ teamId: TEAM_ID, keyId: KEY_ID, privateKeyPem: PRIVATE_KEY, clientId });

type AppleTokenResponse = { refresh_token?: string; id_token?: string };

async function appleToken(clientId: string, params: Record<string, string>): Promise<AppleTokenResponse> {
  const res = await fetch("https://appleid.apple.com/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: await secretFor(clientId), ...params }),
  });
  if (!res.ok) throw new Error(`apple token ${params.grant_type} failed: ${res.status} ${await res.text()}`);
  return await res.json();
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

    if (payload.action === "store") {
      const appleIdentity = user.identities?.find((i) => i.provider === "apple");
      const appleSub = appleIdentity?.identity_data?.sub;
      if (!appleSub) return json({ error: "no apple identity" }, 400);

      let clientId: string;
      let refreshToken: string;
      let idToken: string | undefined;
      if (typeof payload.authorizationCode === "string" && payload.authorizationCode) {
        clientId = BUNDLE_ID;
        const tok = await appleToken(clientId, { grant_type: "authorization_code", code: payload.authorizationCode });
        if (!tok.refresh_token) throw new Error("apple returned no refresh token");
        refreshToken = tok.refresh_token;
        idToken = tok.id_token;
      } else if (typeof payload.refreshToken === "string" && payload.refreshToken) {
        if (!SERVICES_ID) return json({ skipped: "services id not configured" });
        clientId = SERVICES_ID;
        refreshToken = payload.refreshToken;
        // Apple throttles refresh-token validation, so an unchanged grant is a no-op.
        const { data: existing } = await admin.from("apple_auth_grants").select("refresh_token")
          .eq("user_id", user.id).eq("client_id", clientId).maybeSingle();
        if (existing?.refresh_token === refreshToken) return json({ stored: true });
        idToken = (await appleToken(clientId, { grant_type: "refresh_token", refresh_token: refreshToken })).id_token;
      } else {
        return json({ error: "authorizationCode or refreshToken required" }, 400);
      }

      if (jwtClaims(idToken)?.sub !== appleSub) return json({ error: "grant does not match the apple identity" }, 403);

      const { error } = await admin.from("apple_auth_grants").upsert({
        user_id: user.id,
        client_id: clientId,
        refresh_token: refreshToken,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      return json({ stored: true });
    }

    if (payload.action === "revoke") {
      const { data: rows, error } = await admin.from("apple_auth_grants")
        .select("client_id, refresh_token").eq("user_id", user.id);
      if (error) throw error;
      let revoked = 0;
      for (const row of rows ?? []) {
        if (await appleRevoke(row.client_id, row.refresh_token)) {
          revoked++;
          await admin.from("apple_auth_grants").delete().eq("user_id", user.id).eq("client_id", row.client_id);
        }
      }
      return json({ revoked, total: rows?.length ?? 0 });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    console.error("apple-auth error", err);
    return json({ error: String(err) }, 500);
  }
});
