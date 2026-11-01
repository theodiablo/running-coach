import { supabase } from "../supabase";
import { isNative, isIos } from "../native";
import { WEB_APP_ORIGIN } from "../constants";
import { CLOUD_OAUTH, type CloudOauthProviderId } from "../cloudOauthPreinit";

// Shared machinery for cloud import providers whose secret half lives in an edge
// function: OAuth redirect, CSRF-validated return, PKCE, and the invoke seam.
// Providers build on makeCloudOauth. Return plumbing: cloudOauthPreinit.ts (web),
// App.tsx processUrl (native deep link), RunningCoach.finishCloudReturn.

// Outcome of a boot-time OAuth return:
//   "idle"      - not this provider's return, a handled denial, or a rejected state (CSRF)
//   "connected" - a token was just stored; caller enables + scans
//   "failed"    - authorized but the server-side exchange failed; caller surfaces an error
export type CloudAuthResult = "idle" | "connected" | "failed";

export type CloudOauthSpec = {
  provider: CloudOauthProviderId;
  authUrl: string;
  clientId: string | undefined;
  scope: string;
  // Edge function name for the exchange (and the provider's other actions).
  functionName: string;
  // Opt-in per provider: PKCE changes the live authorization request, which
  // can't be exercised against a shipped integration's OAuth server (Polar) —
  // enable it only for providers verified with it (Suunto) or new ones.
  pkce?: boolean;
};

export type CloudOauth = {
  enabled: boolean;
  connect: () => Promise<boolean | "pending">;
  completeAuth: () => Promise<CloudAuthResult>;
  invoke: <T>(body: { action: string; [k: string]: unknown }) => Promise<T | null>;
  // The exact state strings a return may carry for one nonce — exported for tests.
  expectedStates: (nonce: string) => string[];
};

// Random per-connect nonce for the OAuth `state` (CSRF guard). crypto.randomUUID
// needs a secure context (prod/preview are https); the fallback is only a
// defensive last resort — the security property is that the value lives in this
// browser's sessionStorage and an attacker can't read or set it.
function newNonce(): string {
  try { if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// PKCE (S256): the custom-scheme deep link is claimable by any Android app, so an
// intercepted code alone must be useless without this verifier (never leaves the
// device). Only when spec.pkce is set; null without WebCrypto (flow proceeds without).
async function newPkce(): Promise<{ verifier: string; challenge: string } | null> {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle || !crypto.getRandomValues) return null;
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const verifier = b64url(raw);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return { verifier, challenge: b64url(new Uint8Array(digest)) };
  } catch { return null; }
}

// Redirect URL registered with the provider; the exchange must send the identical
// string (OAuth requires byte-equality). Detected by the `state` marker, so it never
// collides with Supabase's ?code=. On native it MUST be the canonical production
// origin (not capacitor://localhost): the web app bounces it to the deep link.
const redirectUri = () =>
  isNative ? WEB_APP_ORIGIN + "/" : (typeof window !== "undefined" ? window.location.origin + "/" : "");

// Storage seam for the handshake values. Web uses sessionStorage; native MUST use
// localStorage because the OS can kill the app while the system browser is open and
// the relaunch is a fresh WebView (the CSRF nonce would be lost). Reads check both.
const readStash = (key: string): string | null => {
  try { const v = sessionStorage.getItem(key); if (v != null) return v; } catch { /* unavailable */ }
  try { return localStorage.getItem(key); } catch { return null; }
};
const clearStash = (key: string): void => {
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
  try { localStorage.removeItem(key); } catch { /* ignore */ }
};
const writeConnectValue = (key: string, value: string): void => {
  try {
    if (isNative) localStorage.setItem(key, value);
    else sessionStorage.setItem(key, value);
  } catch { /* storage unavailable — the return's state check will just fail closed */ }
};

// Pure authorization-URL builder — exported so tests can assert exactly what
// a provider's connect() navigates to (PKCE params present only when opted in).
export function buildAuthUrl(
  spec: Pick<CloudOauthSpec, "authUrl" | "clientId" | "scope">,
  opts: { state: string; redirectUri: string; challenge?: string | null },
): string {
  const url = new URL(spec.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", spec.clientId!);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  // COROS's authorization endpoint documents no `scope` parameter at all
  // (API Reference V2.0.6 §3.1.3), so an empty scope sends none. Polar's and
  // Suunto's live URLs are unchanged — theirs are non-empty.
  if (spec.scope) url.searchParams.set("scope", spec.scope);
  url.searchParams.set("state", opts.state);
  if (opts.challenge) {
    url.searchParams.set("code_challenge", opts.challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

export function makeCloudOauth(spec: CloudOauthSpec): CloudOauth {
  const keys = CLOUD_OAUTH[spec.provider];
  const enabled = !!spec.clientId;

  const sep = keys.stateSep ?? ":";
  const expectedStates = (nonce: string): string[] => [
    keys.statePrefix + sep + nonce,
    keys.nativeStatePrefix + sep + nonce,
  ];

  const invoke = async <T,>(body: { action: string; [k: string]: unknown }): Promise<T | null> => {
    try {
      const { data, error } = await supabase.functions.invoke(spec.functionName, { body });
      if (error) return null;
      return data as T;
    } catch { return null; }
  };

  // Kick off the OAuth authorization (full-page redirect on web, system browser
  // on native). A per-connect nonce is saved so the return can be
  // CSRF-validated. Completion happens on return via completeAuth() — at boot
  // on web, and on the "rc-cloud-oauth-return" deep-link event on native.
  const connect = async (): Promise<boolean | "pending"> => {
    if (!enabled || typeof window === "undefined") return false;
    // A provider whose state may carry no punctuation (COROS) also needs an
    // alphanumeric nonce, or the UUID's dashes would break the same rule the
    // separator is avoiding. Stripping keeps all 128 bits of randomness.
    const nonce = sep === "" ? newNonce().replace(/[^a-zA-Z0-9]/g, "") : newNonce();
    writeConnectValue(keys.nonceKey, nonce);
    const pkce = spec.pkce ? await newPkce() : null;
    if (pkce) writeConnectValue(keys.verifierKey, pkce.verifier);
    const url = new URL(buildAuthUrl(spec, {
      state: (isNative ? keys.nativeStatePrefix : keys.statePrefix) + sep + nonce,
      redirectUri: redirectUri(),
      challenge: pkce?.challenge,
    }));
    if (isNative) {
      // The app itself stays alive under the external browser, so resolve
      // "pending": the caller drops its spinner without toasting, and the real
      // outcome arrives later via the deep-link event (or never, if the user
      // abandons the browser — in which case the row simply stays disconnected).
      if (isIos) {
        // SFSafariViewController — the OAuth pattern LoginScreen uses; App.tsx
        // closes it when the deep link lands.
        const { Browser } = await import("@capacitor/browser");
        await Browser.open({ url: url.toString() });
      } else {
        // Android: plain top-frame navigation. Capacitor's WebViewClient
        // intercepts the external host (Bridge.launchIntent) and hands it to the
        // OS as an ACTION_VIEW intent — the WebView never leaves the app. Never
        // use @capacitor/browser here (see openStore in UpdatePrompt.tsx).
        window.location.assign(url.toString());
      }
      return "pending";
    }
    window.location.assign(url.toString());
    // The page is navigating away; the real result arrives at the OAuth return, so
    // return a never-settling promise: resolving false would flash a false "access
    // denied" toast on EVERY connect. Trade-off: if navigation never starts, the
    // connect spinner hangs (far rarer, accepted).
    return new Promise<boolean>(() => {});
  };

  // Called at boot and (native) on the "rc-cloud-oauth-return" event: validate a
  // stashed return's state against this device's nonce (CSRF guard), then exchange
  // the code server-side for a stored token. Stash comes from cloudOauthPreinit (web)
  // or App.tsx (native). No-op on a normal load or when unconfigured.
  const completeAuth = async (): Promise<CloudAuthResult> => {
    if (!enabled || typeof window === "undefined") return "idle";
    const code = readStash(keys.codeKey);
    const returnedState = readStash(keys.stateKey);
    const nonce = readStash(keys.nonceKey);
    const verifier = readStash(keys.verifierKey);
    // One-shot ONLY when consuming a return: clear everything so a reload can't replay
    // the exchange. With no code stashed clear NOTHING: on native a connect may still
    // be in flight, and wiping the nonce would reject the genuine return about to arrive.
    if (code) {
      clearStash(keys.codeKey);
      clearStash(keys.stateKey);
      clearStash(keys.nonceKey);
      clearStash(keys.verifierKey);
    }
    // No code stashed: a normal load, or the user DENIED (?error= stripped by
    // cloudOauthPreinit before React/i18n exist). A denial is deliberately silent
    // ("idle", no toast); "Connect" with a clean URL already reads as not connected.
    // A failed exchange below is not the user's choice, so it IS surfaced.
    if (!code) return "idle";
    // CSRF: the returned state MUST carry the nonce this device generated at
    // connect() time (in either the web or native state format). A forged link
    // carrying an attacker's code won't match, so it's never exchanged into the
    // victim's account (silently ignored).
    if (!nonce || !returnedState || !expectedStates(nonce).includes(returnedState)) return "idle";
    // A genuine return with a valid state: any non-connected result here is a
    // real failure the user should see (they authorized and expect a result).
    const res = await invoke<{ connected?: boolean }>({
      action: "exchange",
      code,
      redirectUri: redirectUri(),
      ...(verifier ? { codeVerifier: verifier } : {}),
    });
    return res?.connected ? "connected" : "failed";
  };

  return { enabled, connect, completeAuth, invoke, expectedStates };
}
