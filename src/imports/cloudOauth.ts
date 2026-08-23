import { supabase } from "../supabase";
import { isNative, isIos } from "../native";
import { WEB_APP_ORIGIN } from "../constants";
import { CLOUD_OAUTH, type CloudOauthProviderId } from "../cloudOauthPreinit";

// Shared machinery for cloud import providers whose secret half lives in an
// edge function: the OAuth authorization redirect (web full-page / native
// system browser), the CSRF-validated return, PKCE, and the function invoke
// seam. Providers (polar.ts, …) build on makeCloudOauth and keep only their
// data mapping and scan logic. Return plumbing: cloudOauthPreinit.ts (web),
// App.tsx processUrl (native deep link), RunningCoach.finishCloudReturn.

// Outcome of a boot-time OAuth return:
//   "idle"      — not a return for this provider (normal load), a silently-
//                 handled denial, or a rejected state (CSRF). Caller does nothing.
//   "connected" — a token was just stored. Caller enables + scans.
//   "failed"    — the user authorized but the server-side exchange failed (bad
//                 code, provider 5xx, network). Caller surfaces an error so the
//                 user isn't left staring at an unchanged "Connect".
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

// PKCE (S256). The custom-scheme deep link is claimable by any Android app, so
// an intercepted code alone must be useless: the token exchange also needs this
// verifier, which never leaves the initiating device's storage. Only used when
// the provider spec opts in (spec.pkce). Null when WebCrypto is unavailable
// (insecure context) — the flow proceeds without PKCE.
async function newPkce(): Promise<{ verifier: string; challenge: string } | null> {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle || !crypto.getRandomValues) return null;
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const verifier = b64url(raw);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return { verifier, challenge: b64url(new Uint8Array(digest)) };
  } catch { return null; }
}

// Where the provider sends the browser back after authorization — must exactly
// match the redirect URL registered with the provider. The web app root; the
// return is detected by the `state` marker, so it never collides with
// Supabase's PKCE ?code=. On native this MUST be the canonical production
// origin, not window.location.origin (capacitor://localhost, unreachable and
// unregistered): the return lands on the web app, which bounces it to the deep
// link. The same value is passed again at exchange time — OAuth requires the
// token request's redirect_uri to equal the authorization request's
// byte-for-byte.
const redirectUri = () =>
  isNative ? WEB_APP_ORIGIN + "/" : (typeof window !== "undefined" ? window.location.origin + "/" : "");

// Storage seam for the OAuth handshake values. Web stashes in sessionStorage
// (per-tab, cleaned up with the tab); native must use localStorage because the
// OS can kill the app while the system browser is open — the cold-start
// relaunch via the deep link is a fresh WebView session and sessionStorage is
// gone (the CSRF nonce would be lost and every cold-start return would be
// rejected). Reads check both so one code path serves both platforms.
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
    // The page is navigating away to the provider; the real result only arrives
    // on the OAuth return (completeAuth at boot), so there is no boolean to give
    // here. Resolving false would make the settings panel flash a false
    // "access denied" toast on EVERY connect (the promise settles a microtask
    // before the browser unloads). So return a never-settling promise instead.
    // TRADE-OFF: if the navigation somehow never starts (assign blocked), the
    // connect spinner hangs — accepted, as that's far rarer than the
    // guaranteed false-error-on-every-connect the naive `return false` caused.
    return new Promise<boolean>(() => {});
  };

  // Called at app boot and (native) on the "rc-cloud-oauth-return" deep-link
  // event: if an OAuth return was stashed — by cloudOauthPreinit on web
  // (sessionStorage, after stripping the URL before Supabase could touch it) or
  // by App.tsx's deep-link handler on native (localStorage) — validate the
  // state against this device's connect-time nonce (CSRF guard), then exchange
  // the code server-side for a stored token. A no-op on every normal load and
  // when the provider is unconfigured.
  const completeAuth = async (): Promise<CloudAuthResult> => {
    if (!enabled || typeof window === "undefined") return "idle";
    const code = readStash(keys.codeKey);
    const returnedState = readStash(keys.stateKey);
    const nonce = readStash(keys.nonceKey);
    const verifier = readStash(keys.verifierKey);
    // One-shot ONLY when actually consuming a return: clear everything so a
    // reload can't replay the exchange. When no code is stashed, clear NOTHING —
    // on native a connect can still be in flight while the app boots (the OS
    // killed it under the system browser and something other than the deep link
    // relaunched it, or the boot ran before App.tsx finished stashing); wiping
    // the nonce then would reject the genuine return that's about to arrive.
    if (code) {
      clearStash(keys.codeKey);
      clearStash(keys.stateKey);
      clearStash(keys.nonceKey);
      clearStash(keys.verifierKey);
    }
    // No code stashed → either a normal load (not this provider's return) OR
    // the user DENIED on the provider's page (the return carried ?error= and no
    // code; cloudOauthPreinit already stripped it from the URL). TRADE-OFF: a
    // denial is handled silently (returns "idle" → no toast). Deliberate: the
    // denial has to be detected pre-app-boot (in cloudOauthPreinit, before
    // React/i18n exist), so surfacing a localized "you cancelled" message would
    // mean plumbing a flag from there into the app just for the case where the
    // user themselves chose to cancel — not worth it. The visible outcome
    // (still "Connect", clean URL) already reads as "not connected". (This
    // differs from a *failed exchange* below, which the user didn't choose and
    // so IS surfaced.)
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
