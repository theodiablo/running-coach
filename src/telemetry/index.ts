// Vendor-agnostic telemetry (analytics + crash reporting) seam. Nothing leaves
// the device unless a provider is configured AND the user opted in to that
// channel. Only ./posthog.js imports an SDK. See docs/telemetry.md.

import { isNative } from "../native";
import { posthogProvider } from "./posthog";

// localStorage so consent is known *synchronously at boot* (before app_state loads) and the SDK never
// inits pre-consent. These two keys are the single source of truth for the consent UI and Settings.
// `_v2`: the old opt-out build auto-wrote the v1 key to "1", so a v1 value means "defaulted", NOT
// "agreed"; rotating the key forces a genuine opt-in decision.
export const TELEMETRY_CONSENT_KEY = "rc_telemetry_consent_v2";
// Crash reporting is a separate channel with its own switch. An absent value inherits the analytics key
// (getCrashConsentDecision): the single choice it replaced covered both, so nobody is re-asked and
// nobody is upgraded from "no" to "yes".
export const CRASH_CONSENT_KEY = "rc_crash_consent_v1";

// ---- Provider seam -------------------------------------------------------
// The single point of vendor coupling; nothing below knows the SDK. Adapter: isConfigured(),
// setConsent({analytics, crashes}), identify(id), reset(), track(event, props),
// captureError(error, context), startCookieless() (anonymous, storage-free pageviews).
const provider = posthogProvider;
export type TelemetryProps = Record<string, unknown>;
export type ConsentChoice = { analytics: boolean; crashes: boolean };
type Decision = "granted" | "denied" | "unset";

// ---- Consent -------------------------------------------------------------
let started = false;

// Opt-IN (EU/ePrivacy): nothing is collected until the user says so. Flags are per-device (localStorage,
// not the synced blob): "1" granted, "0" denied, absent undecided. Storage can be unavailable (private
// mode), so reads are try/catch and the safe default is "undecided", i.e. off.
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

// Public pages (`/watch/:token`) only, in place of initTelemetry: anonymous
// audience measurement that stores nothing on the device, so it needs no banner.
// An explicit "Decline" in this browser is still honoured. Crash reports keep
// their own consent gate at the call sites. docs/telemetry.md.
export function initPublicPageTelemetry() {
  if (!provider.isConfigured() || getConsentDecision() === "denied") return;
  provider.startCookieless();
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
// Low-level "send this error". Does NOT check consent: call sites do (ErrorBoundary, global handlers),
// gated on getCrashConsent(), its own switch independent of product analytics.
export function captureError(error: Error, context?: TelemetryProps) {
  if (!provider.isConfigured()) return;
  provider.captureError(error, context || {});
}

// ---- Global handlers (web only) -----------------------------------------
// Foreground browser errors that miss the ErrorBoundary; consent-gated at fire time. Web only: on native
// the ErrorBoundary installs its OWN window listeners, so installing here would double-report. Every
// crash rides the bundled captureException (PostHog's remote autocapture is blocked by our CSP).
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
