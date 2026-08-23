// Vendor-agnostic telemetry (analytics + crash reporting) seam. Nothing leaves
// the device unless a provider is configured AND the user opted in to that
// channel. Only ./posthog.js imports an SDK. See docs/telemetry.md.

import { isNative } from "../native";
import { posthogProvider } from "./posthog";

// localStorage so consent is known *synchronously at boot*, before the Supabase
// app_state blob loads (same reason the live-run/bg-location flags live there)
// and so the SDK never inits pre-consent. These two keys are the single source
// of truth for consent — the first-run consent UI and the Settings toggles both
// read/write them here.
//
// `_v2`: the earlier opt-out build *auto-wrote* the v1 key ("rc_telemetry_consent")
// to "1" on load (default-on, mirrored from settings), so a stored v1 value means
// "defaulted", NOT "user agreed". Rotating the key discards those and forces a
// genuine opt-in decision for everyone — the compliant migration to opt-in.
export const TELEMETRY_CONSENT_KEY = "rc_telemetry_consent_v2";
// Crash reporting is a separate channel with its own switch. An absent value
// inherits the analytics key (see getCrashConsentDecision): the single choice it
// replaced covered "usage analytics and crash reports", so an existing answer is
// still an answer for both — nobody gets re-asked, and nobody is upgraded from
// "no" to "yes".
export const CRASH_CONSENT_KEY = "rc_crash_consent_v1";

// ---- Provider seam -------------------------------------------------------
// The single point of vendor coupling. Swap this for a different adapter to
// change vendors; nothing else below knows which SDK is behind it. The adapter
// implements:
//
//   isConfigured(): boolean              key present in env, safe to init
//   setConsent({analytics, crashes}): void   start/stop to match consent
//   identify(id): void
//   reset(): void
//   track(event, props): void
//   captureError(error, context): void
//
const provider = posthogProvider;
export type TelemetryProps = Record<string, unknown>;
export type ConsentChoice = { analytics: boolean; crashes: boolean };
type Decision = "granted" | "denied" | "unset";

// ---- Consent -------------------------------------------------------------
let started = false;

// Opt-IN model (EU/ePrivacy): nothing is collected until the user explicitly
// says so — both channels start off and stay off until answered. The flags are
// per-device (localStorage, not the synced app_state blob) because consent to
// store data on a device is inherently per-device — a fresh browser should ask
// again. Three states per channel:
//   "1"  granted     "0"  denied     absent  undecided (not answered yet)
// Wrapped in try/catch because storage can be unavailable (private mode / locked)
// — in which case the safe default is "undecided", i.e. off.
function read(key: string): Decision {
  try {
    const v = localStorage.getItem(key);
    return v === "1" ? "granted" : v === "0" ? "denied" : "unset";
  } catch {
    return "unset";
  }
}

function write(key: string, enabled: boolean) {
  try {
    localStorage.setItem(key, enabled ? "1" : "0");
  } catch { /* storage unavailable — the getters fall back to off */ }
}

// Product analytics. Also the "has the user been asked?" channel: the first-run
// consent UI shows while this one is "unset" and answers both.
export function getConsentDecision(): Decision {
  return read(TELEMETRY_CONSENT_KEY);
}

export function getConsent() {
  return getConsentDecision() === "granted";
}

// Crash reports. Inherits the analytics answer when never set explicitly (see
// CRASH_CONSENT_KEY), so an upgrading install keeps exactly the choice it made.
export function getCrashConsentDecision(): Decision {
  const own = read(CRASH_CONSENT_KEY);
  return own === "unset" ? getConsentDecision() : own;
}

export function getCrashConsent() {
  return getCrashConsentDecision() === "granted";
}

// Whether a real provider is wired in AND keyed. The Settings toggles still
// render regardless (so the choice is always visible), but flipping them is
// inert until this is true.
export function isTelemetryConfigured() {
  return provider.isConfigured();
}

// Push the current per-channel consent at the provider. The adapter owns what
// that means for its SDK (load or stay unloaded, opt in/out, which automatic
// events are allowed); the seam only ever states the two answers.
function syncProvider() {
  if (!provider.isConfigured()) return;
  const analytics = getConsent();
  const crashes = getCrashConsent();
  provider.setConsent({ analytics, crashes });
  started = analytics || crashes;
}

// Called once at app start (main.tsx) and again whenever consent changes.
export function initTelemetry() {
  syncProvider();
}

// Persist the user's choice and bring the provider in line. Called from the
// first-run consent UI and the Settings → Privacy toggles.
export function setConsent(enabled: boolean) {
  write(TELEMETRY_CONSENT_KEY, enabled);
  syncProvider();
}

export function setCrashConsent(enabled: boolean) {
  write(CRASH_CONSENT_KEY, enabled);
  syncProvider();
}

// Both channels at once — the first-run screen answers them together, so it
// must never leave one written and the other undecided.
export function setTelemetryConsent({ analytics, crashes }: ConsentChoice) {
  write(TELEMETRY_CONSENT_KEY, analytics);
  write(CRASH_CONSENT_KEY, crashes);
  syncProvider();
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
// Analytics events. Silently dropped without a provider or analytics consent.
export function track(event: string, props?: TelemetryProps) {
  if (!started || !getConsent()) return;
  provider.track(event, props || {});
}

// ---- Crash reporting -----------------------------------------------------
// Low-level "send this error to the provider". Does NOT check consent itself —
// the call sites do (the ErrorBoundary and the global handlers below), gated on
// getCrashConsent(), which is its own switch: crash diagnostics can be on with
// product analytics off, and vice versa.
export function captureError(error: Error, context?: TelemetryProps) {
  if (!provider.isConfigured()) return;
  provider.captureError(error, context || {});
}

// ---- Global handlers (web only) -----------------------------------------
// Foreground browser errors that never reach the React ErrorBoundary (event
// handlers, async callbacks, rejected promises). Consent-gated at fire time.
// Web only by design: on native the ErrorBoundary installs its OWN window
// `error` / `unhandledrejection` listeners (so it can also show the crash
// screen) and auto-reports them consent-permitting — installing here too would
// double-report. Both platforms capture the same way; PostHog's remote
// exception-autocapture is unused (blocked by our CSP), so every crash rides the
// bundled captureException from here or the ErrorBoundary.
let handlersInstalled = false;
export function installGlobalErrorHandlers() {
  if (handlersInstalled || typeof window === "undefined" || isNative) return;
  handlersInstalled = true;
  window.addEventListener("error", (e) => {
    if (getCrashConsent()) {
      captureError(e.error || new Error(e.message), { kind: "window.error" });
    }
  });
  window.addEventListener("unhandledrejection", (e) => {
    if (getCrashConsent()) {
      const err = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
      captureError(err, { kind: "unhandledrejection" });
    }
  });
}
