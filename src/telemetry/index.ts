// Vendor-agnostic telemetry (analytics + crash reporting) seam. Nothing leaves
// the device unless a provider is configured AND the user opted in via
// ConsentBanner; native crashes get an additional per-crash prompt regardless.
// Only ./posthog.js imports an SDK. See docs/telemetry.md.

import { isNative } from "../native";
import { posthogProvider } from "./posthog";

// localStorage so consent is known *synchronously at boot*, before the Supabase
// app_state blob loads (same reason the live-run/bg-location flags live there)
// and so the SDK never inits pre-consent. It is the single source of truth for
// consent — the ConsentBanner and the Settings toggle both read/write it here.
//
// `_v2`: the earlier opt-out build *auto-wrote* the v1 key ("rc_telemetry_consent")
// to "1" on load (default-on, mirrored from settings), so a stored v1 value means
// "defaulted", NOT "user agreed". Rotating the key discards those and forces a
// genuine opt-in decision for everyone — the compliant migration to opt-in.
export const TELEMETRY_CONSENT_KEY = "rc_telemetry_consent_v2";

// ---- Provider seam -------------------------------------------------------
// The single point of vendor coupling. Swap this for a different adapter to
// change vendors; nothing else below knows which SDK is behind it. The adapter
// implements:
//
//   isConfigured(): boolean              key present in env, safe to init
//   init(): void                         start the SDK (once consent is given)
//   shutdown(): void                     stop/flush the SDK (on opt-out)
//   identify(id): void
//   reset(): void
//   track(event, props): void
//   captureError(error, context): void
//
const provider = posthogProvider;
export type TelemetryProps = Record<string, unknown>;

// ---- Consent -------------------------------------------------------------
let started = false;

// Opt-IN model (EU/ePrivacy): nothing is collected until the user explicitly
// accepts via the first-run ConsentBanner. The flag is per-device (localStorage,
// not the synced app_state blob) because consent to store data on a device is
// inherently per-device — a fresh browser should ask again. Three states:
//   "1"  granted     "0"  denied     absent  undecided (banner not answered yet)
// Wrapped in try/catch because storage can be unavailable (private mode / locked)
// — in which case the safe default is "undecided", i.e. off.
export function getConsentDecision() {
  try {
    const v = localStorage.getItem(TELEMETRY_CONSENT_KEY);
    return v === "1" ? "granted" : v === "0" ? "denied" : "unset";
  } catch {
    return "unset";
  }
}

export function getConsent() {
  return getConsentDecision() === "granted";
}

// Whether a real provider is wired in AND keyed. The Settings toggle still
// renders regardless (so the choice is always visible), but flipping it is
// inert until this is true.
export function isTelemetryConfigured() {
  return provider.isConfigured();
}

function start() {
  if (started || !provider.isConfigured()) return;
  provider.init();
  started = true;
}

function stop() {
  if (!started) return;
  provider.shutdown();
  started = false;
}

// Called once at app start (main.jsx) and again whenever consent changes.
export function initTelemetry() {
  if (provider.isConfigured() && getConsent()) start();
}

// Persist the user's choice and start/stop the provider to match. Called from
// the first-run ConsentBanner and the Settings → Privacy toggle.
export function setConsent(enabled: boolean) {
  try {
    localStorage.setItem(TELEMETRY_CONSENT_KEY, enabled ? "1" : "0");
  } catch { /* storage unavailable — getConsent() will fall back to off */ }
  if (enabled) start();
  else stop();
}

// ---- Identity ------------------------------------------------------------
export function identifyUser(id: string) {
  if (!started || !getConsent()) return;
  provider.identify(id);
}

export function resetUser() {
  if (!started) return;
  provider.reset();
}

// ---- Events --------------------------------------------------------------
// Analytics events. Silently dropped without a provider or consent.
export function track(event: string, props?: TelemetryProps) {
  if (!started || !getConsent()) return;
  provider.track(event, props || {});
}

// ---- Crash reporting -----------------------------------------------------
// Low-level "send this error to the provider". Does NOT check consent itself —
// the call sites do, so the rules stay explicit:
//   • web: ErrorBoundary / global handlers call this only when getConsent().
//   • native: the crash screen calls this ONLY after the user taps "Send
//     report", so a crash is never reported without an explicit per-crash OK
//     (even if analytics consent is already on).
export function captureError(error: Error, context?: TelemetryProps) {
  if (!provider.isConfigured()) return;
  // No start()/consent flip here: the adapter loads the SDK on demand and sends
  // just this one error even while opted out, so an opted-out user's per-crash
  // "Send report" never silently re-enables analytics.
  provider.captureError(error, context || {});
}

// ---- Global handlers (web only) -----------------------------------------
// Foreground browser errors that never reach the React ErrorBoundary (event
// handlers, async callbacks, rejected promises). Consent-gated at fire time.
// Web only by design: on native the ErrorBoundary installs its OWN window
// `error` / `unhandledrejection` listeners (so it can also show the crash
// screen) and auto-reports them consent-permitting — installing here too would
// double-report. Both platforms now capture the same way (auto-report when the
// user has granted analytics consent); PostHog's remote exception-autocapture
// is unused (blocked by our CSP), so every crash rides the bundled
// captureException from here or the ErrorBoundary.
let handlersInstalled = false;
export function installGlobalErrorHandlers() {
  if (handlersInstalled || typeof window === "undefined" || isNative) return;
  handlersInstalled = true;
  window.addEventListener("error", (e) => {
    if (getConsent()) {
      captureError(e.error || new Error(e.message), { kind: "window.error" });
    }
  });
  window.addEventListener("unhandledrejection", (e) => {
    if (getConsent()) {
      const err = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
      captureError(err, { kind: "unhandledrejection" });
    }
  });
}
