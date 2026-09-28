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

// ASAuthorizationError.canceled (1001) surfaces as a plain rejection whose
// message is the NSError description; there is no structured code to read.
function isUserCancelled(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? "");
  return /1001|cancel/i.test(text);
}

// Hands Apple's grant to the server so account deletion can revoke it
// (guideline 5.1.1(v)). Best-effort: sign-in never waits on or fails with it.
function storeAppleGrant(body: { authorizationCode: string } | { refreshToken: string }) {
  void supabase.functions.invoke("apple-auth", { body: { action: "store", ...body } })
    .then(({ error }) => { if (error) console.warn("apple-auth store failed", error); })
    .catch(err => console.warn("apple-auth store failed", err));
}

// The browser flow's grant: GoTrue returns Apple's refresh token only on the
// session minted by the OAuth exchange, which App.tsx may see as SIGNED_IN or,
// when the exchange beats its listener, INITIAL_SESSION.
const sentRefreshTokens = new Set<string>();
export function rememberAppleGrant(session: Session | null) {
  const token = session?.provider_refresh_token;
  if (!session || !token || sentRefreshTokens.has(token)) return;
  if (!session.user.identities?.some(i => i.provider === "apple")) return;
  sentRefreshTokens.add(token);
  storeAppleGrant({ refreshToken: token });
}

// The native iOS sheet, or null when this install can't show one: not iOS, an
// older shell without the plugin, or no crypto.subtle to hash the nonce.
export async function nativeAppleSignIn(): Promise<NativeAppleOutcome> {
  if (!isNative || !isIos) return null;
  if (!Capacitor.isPluginAvailable("SignInWithApple")) return null;
  if (!globalThis.crypto?.subtle) return null;

  const { SignInWithApple } = await import("@capacitor-community/apple-sign-in");
  const rawNonce = randomNonce();
  let identityToken: string;
  let authorizationCode: string;
  try {
    const res = await SignInWithApple.authorize({
      clientId: NATIVE_BUNDLE_ID,
      // Unused by the native sheet but required by the plugin's options type.
      redirectURI: AUTH_DEEP_LINK,
      scopes: "email name",
      // Apple embeds the HASH in the identity token; Supabase gets the raw value.
      nonce: await sha256Hex(rawNonce),
    });
    identityToken = res.response.identityToken;
    authorizationCode = res.response.authorizationCode;
  } catch (err) {
    if (isUserCancelled(err)) return "cancelled";
    throw err;
  }

  const { error } = await supabase.auth.signInWithIdToken({
    provider: "apple",
    token: identityToken,
    nonce: rawNonce,
  });
  if (error) throw error;
  if (authorizationCode) storeAppleGrant({ authorizationCode });
  return "signed-in";
}

// Revokes the account's Apple grants before it is deleted. Never blocks the
// deletion: a failure here must not leave the user unable to leave.
export async function revokeAppleGrants(session: Session | null): Promise<void> {
  if (!session?.user.identities?.some(i => i.provider === "apple")) return;
  try {
    const { error } = await supabase.functions.invoke("apple-auth", { body: { action: "revoke" } });
    if (error) console.warn("apple-auth revoke failed", error);
  } catch (err) {
    console.warn("apple-auth revoke failed", err);
  }
}
