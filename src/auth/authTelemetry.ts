import { track } from "../telemetry";

// Sign-in funnel events (docs/telemetry.md, "Sign-in"). Enums and GoTrue's own
// error codes only: never a message, an address or a URL.
export type AuthMethod = "password" | "signup" | "google" | "apple" | "apple_native" | "deeplink";
export type AuthFailStage = "request" | "browser" | "provider" | "exchange";
type OAuthProvider = "google" | "apple";

// GoTrue's codes are a fixed snake_case vocabulary; anything else stays on the device.
const SAFE_CODE = /^[a-z0-9_]{1,48}$/;

export function authFailureCode(err: unknown): string {
  if (typeof err === "string") return SAFE_CODE.test(err) ? err : "unknown";
  if (!err || typeof err !== "object") return "unknown";
  const { code, status, name, message } = err as { code?: unknown; status?: unknown; name?: unknown; message?: unknown };
  if (typeof code === "string" && SAFE_CODE.test(code)) return code;
  // supabase-js wraps a request that never got an answer as status 0; our own abort says "timed out".
  if (name === "AuthRetryableFetchError" && (status === 0 || status == null)) {
    return typeof message === "string" && /timed out/i.test(message) ? "timeout" : "network";
  }
  if (typeof status === "number" && status > 0) return `http_${status}`;
  if (err instanceof TypeError) return "network";
  return "unknown";
}

export function trackAuthStarted(method: AuthMethod) {
  track("auth_started", { method });
}

export function trackAuthCompleted(method: AuthMethod) {
  track("auth_completed", { method });
}

export function trackAuthFailed(method: AuthMethod, stage: AuthFailStage, err: unknown) {
  track("auth_failed", { method, stage, code: authFailureCode(err) });
}

export function trackAuthCancelled(method: AuthMethod, extra: { loaded?: boolean; secs?: number } = {}) {
  track("auth_cancelled", { method, ...extra });
}

// The browser OAuth round trip spans the app and a deep link, so which provider
// it was lives here until the callback (or the user closing the sheet) settles it.
type Pending = { provider: OAuthProvider; at: number; loaded: boolean; cleanup: () => void };
let pending: Pending | null = null;

const MAX_SECS = 600;

export function oauthOpened(provider: OAuthProvider, cleanup: () => void = () => {}) {
  pending?.cleanup();
  pending = { provider, at: Date.now(), loaded: false, cleanup };
}

export function oauthPageLoaded() {
  if (pending) pending.loaded = true;
}

// The user closed the in-app browser themselves; a programmatic close after the
// callback never gets here because the callback settles `pending` first.
export function oauthClosedByUser() {
  const p = pending;
  if (!p) return;
  pending = null;
  p.cleanup();
  const secs = Math.min(MAX_SECS, Math.round((Date.now() - p.at) / 1000));
  trackAuthCancelled(p.provider, { loaded: p.loaded, secs });
}

// Called when an auth deep link lands: the provider that started it, or
// "deeplink" for an email link, a restart, or a tap abandoned long ago
// (Android's system browser never says it was closed).
export function settleOAuth(): AuthMethod {
  const p = pending;
  pending = null;
  p?.cleanup();
  return p && Date.now() - p.at <= MAX_SECS * 1000 ? p.provider : "deeplink";
}
