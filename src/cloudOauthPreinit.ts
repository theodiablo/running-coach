// Must run BEFORE the Supabase client exists (imported ahead of ./App in
// main.tsx): Supabase's `detectSessionInUrl` PKCE flow consumes any `?code=`
// as its own auth code, and a cloud provider's OAuth return also lands as
// `?code=` at the app root — this strips and stashes the provider's code first
// so Supabase never sees it. The provider's completeAuth (imports/cloudOauth.ts)
// picks it up. Two return shapes (web vs native bounce): docs/integrations-polar.md.
//
// Stay dependency-free (no React, no i18n, no supabase) — importing supabase
// here would create the client early, the exact race this file exists to win.

export type CloudOauthProviderId = "polar";

export type CloudOauthConfig = {
  // OAuth `state` markers. Native-initiated connects mark their state so the
  // web bounce knows the return belongs to the app, not the browser tab. The
  // native prefix still starts with the plain one, so check native FIRST.
  statePrefix: string;
  nativeStatePrefix: string;
  // The provider's deep link. Same scheme as AUTH_DEEP_LINK (supabase.ts),
  // different host — Android needs a matching intent filter (AndroidManifest),
  // iOS already claims the whole scheme via CFBundleURLTypes.
  deepLink: string;
  // Storage keys for the OAuth handshake (code/state stashed on return; nonce
  // and PKCE verifier written at connect() time).
  codeKey: string;
  stateKey: string;
  nonceKey: string;
  verifierKey: string;
};

// Every cloud OAuth provider this preinit watches for. Adding one = add its
// entry here (keys must stay globally unique and no provider's statePrefix may
// be a prefix of another's — asserted in polar.test.ts) plus an AndroidManifest
// intent filter for the deep-link host.
export const CLOUD_OAUTH: Record<CloudOauthProviderId, CloudOauthConfig> = {
  polar: {
    statePrefix: "polar_import",
    nativeStatePrefix: "polar_import:native",
    deepLink: "solutions.camboulive.run://polar-callback",
    codeKey: "rc_polar_oauth_code",
    stateKey: "rc_polar_oauth_state",
    nonceKey: "rc_polar_oauth_nonce",
    verifierKey: "rc_polar_oauth_verifier",
  },
};

export const cloudOauthProviderIds = Object.keys(CLOUD_OAUTH) as CloudOauthProviderId[];

// Native-side stash, written by App.tsx when the deep link arrives. localStorage,
// NOT sessionStorage: the OS may have killed the app while the OAuth browser was
// open, and the cold-start relaunch is a fresh WebView session.
export function stashCloudReturn(provider: CloudOauthProviderId, code: string, state: string): void {
  const cfg = CLOUD_OAUTH[provider];
  try {
    localStorage.setItem(cfg.codeKey, code);
    localStorage.setItem(cfg.stateKey, state);
  } catch { /* storage unavailable — the exchange will just not happen */ }
}

// Pure classification of a landing URL's query — exported for tests.
export type CloudReturn =
  | { provider: CloudOauthProviderId; kind: "web" | "native"; code: string | null; state: string }
  | { provider: null; kind: "none"; code: null; state: null };

export function classifyCloudReturn(search: string): CloudReturn {
  const params = new URLSearchParams(search);
  const state = params.get("state");
  if (!state) return { provider: null, kind: "none", code: null, state: null };
  for (const provider of cloudOauthProviderIds) {
    const cfg = CLOUD_OAUTH[provider];
    if (!state.startsWith(cfg.statePrefix + ":")) continue;
    const kind = state.startsWith(cfg.nativeStatePrefix + ":") ? "native" : "web";
    return { provider, kind, code: params.get("code"), state };
  }
  return { provider: null, kind: "none", code: null, state: null };
}

// The bounce overlay is pre-React and pre-i18n, so it carries its own three
// lines of copy (the app's locales). Prefer the user's SAVED app language
// (rc_lang, the same key src/i18n/detect.ts reads) so it matches what they
// picked in-app; fall back to the browser/OS locale only when unset. The bounce
// runs in the phone's browser, but rc_lang is set on this origin when they use
// the web app, and it's the best signal available here.
function bounceCopy(): { returning: string; open: string } {
  let lang = "";
  try { lang = (localStorage.getItem("rc_lang") || "").slice(0, 2).toLowerCase(); } catch { /* storage unavailable */ }
  if (!lang) lang = (typeof navigator !== "undefined" ? navigator.language || "" : "").slice(0, 2).toLowerCase();
  if (lang === "fr") return { returning: "Retour vers Running Coach…", open: "Ouvrir l'application" };
  if (lang === "es") return { returning: "Volviendo a Running Coach…", open: "Abrir la aplicación" };
  return { returning: "Returning to Running Coach…", open: "Open the app" };
}

// Full-screen overlay with a real anchor: a user tap is the one navigation
// browsers never block for custom schemes. Injected before React mounts and
// left in place — the SPA boots behind it, which is harmless (and useful if
// the user stays in the browser: closing the overlay is just closing the tab).
function showBounceOverlay(target: string): void {
  const copy = bounceCopy();
  const el = document.createElement("div");
  el.setAttribute("style",
    "position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;" +
    "justify-content:center;gap:20px;background:#0f172a;color:#e2e8f0;" +
    "font-family:system-ui,sans-serif;text-align:center;padding:24px;");
  const msg = document.createElement("p");
  msg.textContent = copy.returning;
  msg.setAttribute("style", "font-size:15px;margin:0;color:#94a3b8;");
  const a = document.createElement("a");
  a.href = target;
  a.textContent = copy.open;
  a.setAttribute("style",
    "background:#f97316;color:#fff;font-weight:600;font-size:16px;padding:14px 28px;" +
    "border-radius:14px;text-decoration:none;");
  el.appendChild(msg);
  el.appendChild(a);
  const mount = () => { document.body.appendChild(el); };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
}

try {
  if (typeof window !== "undefined") {
    const ret = classifyCloudReturn(window.location.search);
    if (ret.provider) {
      const cfg = CLOUD_OAUTH[ret.provider];
      if (ret.kind === "web") {
        // A web-connect return (success carries `code`; a denial carries `error`
        // and no code). Stash a code for the provider's completeAuth to
        // validate + exchange.
        if (ret.code) {
          try {
            sessionStorage.setItem(cfg.codeKey, ret.code);
            sessionStorage.setItem(cfg.stateKey, ret.state);
          } catch { /* storage unavailable — non-fatal */ }
        }
      }
      // Strip our params (and any denial error) so Supabase never sees a `code`
      // and the address bar doesn't keep a stale ?code=/?error= around. Done
      // BEFORE the native redirect attempt so a back-navigation can't replay it.
      const url = new URL(window.location.href);
      for (const k of ["code", "state", "error", "error_description"]) url.searchParams.delete(k);
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
      if (ret.kind === "native") {
        // Hand the return to the app. Forward the code AND the state — the app
        // validates the state against the nonce it stored at connect() time
        // (CSRF), this page performs no validation of its own. A denial (no
        // code) is still forwarded so the app can close its iOS browser sheet.
        const target = cfg.deepLink + "?state=" + encodeURIComponent(ret.state) +
          (ret.code ? "&code=" + encodeURIComponent(ret.code) : "");
        showBounceOverlay(target);
        try { window.location.replace(target); } catch { /* blocked — the overlay's tap target remains */ }
      }
    }
  }
} catch { /* never block boot on a URL/storage quirk */ }
