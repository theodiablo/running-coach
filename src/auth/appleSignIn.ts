import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { supabase, authRedirectTo, AUTH_DEEP_LINK, NATIVE_BUNDLE_ID } from "../supabase";
import { isNative, isIos, isAndroid } from "../native";

// "cancelled" is the sheet dismissed by the user: nothing failed, so the caller
// says nothing. "redirecting" means the page itself is leaving for Apple.
export type AppleSignInOutcome = "signed-in" | "redirecting" | "cancelled";

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

// The native sheet, or null when this install can't show one — an older shell
// without the plugin, or a WebView whose origin isn't a secure context (no
// crypto.subtle, so the nonce hash can't be built). Both fall back to the web
// flow rather than dead-ending the one button Apple requires us to offer.
async function nativeAppleSignIn(): Promise<AppleSignInOutcome | null> {
  if (!isNative || !isIos) return null;
  if (!Capacitor.isPluginAvailable("SignInWithApple")) return null;
  if (!globalThis.crypto?.subtle) return null;

  const { SignInWithApple } = await import("@capacitor-community/apple-sign-in");
  const rawNonce = randomNonce();
  let identityToken: string;
  try {
    const res = await SignInWithApple.authorize({
      clientId: NATIVE_BUNDLE_ID,
      // Unused by the native sheet (it returns straight to the app) but
      // required by the plugin's shared web/native options type.
      redirectURI: AUTH_DEEP_LINK,
      scopes: "email name",
      // Apple embeds the HASH in the identity token; Supabase is handed the raw
      // value below and hashes it to compare.
      nonce: await sha256Hex(rawNonce),
    });
    identityToken = res.response.identityToken;
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
  return "signed-in";
}

// The browser flow, identical in shape to withGoogle's: the shell opens the
// provider itself and lets the deep link bring the result back.
async function webAppleSignIn(): Promise<AppleSignInOutcome> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "apple",
    options: { redirectTo: authRedirectTo(), skipBrowserRedirect: isNative },
  });
  if (error) throw error;
  if (isNative && data?.url) {
    // Android must not go through @capacitor/browser — see withGoogle in
    // LoginScreen for why a Custom Tabs failure kills the process.
    if (isAndroid) {
      window.location.assign(data.url);
      return "redirecting";
    }
    await Browser.open({ url: data.url });
    return "redirecting";
  }
  return "redirecting";
}

// Sign in with Apple, native sheet first. Throws the Supabase/plugin error for
// the caller to map through authErrorMessage.
export async function signInWithApple(): Promise<AppleSignInOutcome> {
  return (await nativeAppleSignIn()) ?? (await webAppleSignIn());
}
