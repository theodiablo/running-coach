import { Capacitor } from "@capacitor/core";
import type { Session } from "@supabase/supabase-js";
import { supabase, AUTH_DEEP_LINK, NATIVE_BUNDLE_ID } from "../supabase";
import { isNative, isIos } from "../native";

// "cancelled" is the sheet dismissed by the user: nothing failed, so the caller
// says nothing. null means this install can't show the sheet — use the browser flow.
export type NativeAppleOutcome = "signed-in" | "cancelled" | null;

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");

const randomNonce = () => hex(crypto.getRandomValues(new Uint8Array(32)));

async function sha256Hex(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return hex(new Uint8Array(digest));
}

// ASAuthorizationError.canceled (1001) surfaces only as the NSError description,
// whose wording is localized but whose code is not.
function isUserCancelled(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? "");
  return /\b1001\b/.test(text);
}

// The plugin, when this install can show its sheet at all.
async function applePlugin() {
  if (!isNative || !isIos) return null;
  if (!Capacitor.isPluginAvailable("SignInWithApple")) return null;
  if (!globalThis.crypto?.subtle) return null;
  return import("@capacitor-community/apple-sign-in").then(m => m.SignInWithApple, () => null);
}

// A fresh sheet round trip, for a nonce-bound sign-in or a deletion-time code.
async function authorize(nonce?: string) {
  const plugin = await applePlugin();
  if (!plugin) return null;
  const res = await plugin.authorize({
    clientId: NATIVE_BUNDLE_ID,
    // Unused by the native sheet but required by the plugin's options type.
    redirectURI: AUTH_DEEP_LINK,
    scopes: "email name",
    nonce,
  });
  return res.response;
}

// Hands Apple's grant to the server so account deletion can revoke it
// (guideline 5.1.1(v)). Best-effort: sign-in never waits on or fails with it.
function storeAppleGrant(body: { authorizationCode: string } | { refreshToken: string }) {
  void supabase.functions.invoke("apple-auth", { body: { action: "store", ...body } })
    .then(({ error }) => { if (error) console.warn("apple-auth store failed", error); })
    .catch(err => console.warn("apple-auth store failed", err));
}

// The identity this session was signed in with: the one used most recently.
function signedInWith(session: Session): string | undefined {
  const ids = [...(session.user.identities ?? [])];
  ids.sort((a, b) => Date.parse(b.last_sign_in_at ?? "") - Date.parse(a.last_sign_in_at ?? ""));
  return ids[0]?.provider;
}

// The browser flow's grant: GoTrue returns Apple's refresh token only on the
// session minted by the OAuth exchange, which App.tsx may see as SIGNED_IN or,
// when the exchange beats its listener, INITIAL_SESSION.
const sentRefreshTokens = new Set<string>();
export function rememberAppleGrant(session: Session | null) {
  const token = session?.provider_refresh_token;
  if (!session || !token || sentRefreshTokens.has(token)) return;
  if (signedInWith(session) !== "apple") return;
  sentRefreshTokens.add(token);
  storeAppleGrant({ refreshToken: token });
}

// The native iOS sheet, or null when this install can't show one: not iOS, an
// older shell without the plugin, or no crypto.subtle to hash the nonce.
export async function nativeAppleSignIn(): Promise<NativeAppleOutcome> {
  if (!(await applePlugin())) return null;
  const rawNonce = randomNonce();
  let response;
  try {
    // Apple embeds the HASH in the identity token; Supabase gets the raw value.
    response = await authorize(await sha256Hex(rawNonce));
  } catch (err) {
    if (isUserCancelled(err)) return "cancelled";
    throw err;
  }
  if (!response) return null;

  const { error } = await supabase.auth.signInWithIdToken({
    provider: "apple",
    token: response.identityToken,
    nonce: rawNonce,
  });
  if (error) throw error;
  if (response.authorizationCode) storeAppleGrant({ authorizationCode: response.authorizationCode });
  return "signed-in";
}

const revokeGrants = (authorizationCode?: string) =>
  supabase.functions.invoke<{ revoked?: number; total?: number }>("apple-auth", {
    body: authorizationCode ? { action: "revoke", authorizationCode } : { action: "revoke" },
  });

// Revokes the account's Apple grants before it is deleted. With none stored (an
// account from before grants were kept, or a store that never landed), iOS asks
// the sheet for a fresh code to revoke instead. Never throws: a failure here
// must not leave the user unable to leave.
export async function revokeAppleGrants(session: Session | null): Promise<void> {
  if (!session?.user.identities?.some(i => i.provider === "apple")) return;
  try {
    const { data, error } = await revokeGrants();
    if (error) throw error;
    if (data?.total !== 0) return;
    const fresh = await authorize();
    if (fresh?.authorizationCode) {
      const { error: freshError } = await revokeGrants(fresh.authorizationCode);
      if (freshError) throw freshError;
    }
  } catch (err) {
    console.warn("apple-auth revoke failed", err);
  }
}
