import { describe, it, expect, beforeEach } from "vitest";
import {
  TELEMETRY_CONSENT_KEY,
  CRASH_CONSENT_KEY,
  getConsent,
  getConsentDecision,
  getCrashConsent,
  getCrashConsentDecision,
  setConsent,
  setCrashConsent,
  setTelemetryConsent,
  isTelemetryConfigured,
  track,
  captureError,
  identifyUser,
} from "./index";

// Consent is the security boundary here: nothing ships without it. Opt-in model
// (EU/ePrivacy) — an absent flag means "undecided", which must read as NOT
// consented so the SDK never inits before the first-run banner is answered.
describe("telemetry consent", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to NOT consented and 'unset' when no flag is stored (opt-in)", () => {
    expect(getConsent()).toBe(false);
    expect(getConsentDecision()).toBe("unset");
  });

  it("persists an explicit grant as '1' and reflects it", () => {
    setConsent(true);
    expect(localStorage.getItem(TELEMETRY_CONSENT_KEY)).toBe("1");
    expect(getConsent()).toBe(true);
    expect(getConsentDecision()).toBe("granted");
  });

  it("persists an explicit decline as '0' (distinct from undecided)", () => {
    setConsent(false);
    expect(localStorage.getItem(TELEMETRY_CONSENT_KEY)).toBe("0");
    expect(getConsent()).toBe(false);
    expect(getConsentDecision()).toBe("denied");
  });

  it("can be toggled back off after being granted", () => {
    setConsent(true);
    setConsent(false);
    expect(getConsent()).toBe(false);
    expect(getConsentDecision()).toBe("denied");
  });
});

// Crash reporting is its own channel: a user can want bugs fixed without wanting
// their usage measured (and vice versa). The one thing it must never do is turn
// itself on — an absent flag inherits the analytics answer, which for a fresh
// install is "unset", i.e. off.
describe("crash-report consent", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to off on a fresh install", () => {
    expect(getCrashConsent()).toBe(false);
    expect(getCrashConsentDecision()).toBe("unset");
  });

  it("is independent of analytics once set explicitly", () => {
    setTelemetryConsent({ analytics: false, crashes: true });
    expect(getCrashConsent()).toBe(true);
    expect(getConsent()).toBe(false);

    setConsent(true);
    setCrashConsent(false);
    expect(getConsent()).toBe(true);
    expect(getCrashConsent()).toBe(false);
  });

  it("answers both channels at once so neither is left undecided", () => {
    setTelemetryConsent({ analytics: true, crashes: false });
    expect(localStorage.getItem(TELEMETRY_CONSENT_KEY)).toBe("1");
    expect(localStorage.getItem(CRASH_CONSENT_KEY)).toBe("0");
  });

  // Upgrade path: the choice this replaced covered analytics AND crash reports,
  // so an install that already answered keeps that answer for both — it is never
  // re-asked, and a "no" is never silently upgraded to a "yes".
  it("inherits an existing single-consent answer, in both directions", () => {
    localStorage.setItem(TELEMETRY_CONSENT_KEY, "1");
    expect(getCrashConsent()).toBe(true);

    localStorage.setItem(TELEMETRY_CONSENT_KEY, "0");
    expect(getCrashConsent()).toBe(false);
    expect(getCrashConsentDecision()).toBe("denied");
  });

  it("stops inheriting once the user answers the crash channel itself", () => {
    localStorage.setItem(TELEMETRY_CONSENT_KEY, "1");
    setCrashConsent(false);
    expect(getCrashConsent()).toBe(false);
    expect(getConsent()).toBe(true);
  });
});

// Without VITE_POSTHOG_KEY the adapter is unconfigured, so the whole module is
// inert — no SDK load, no network, every entry point a safe no-op. Guards the
// "ships disabled by default" contract (and keeps this suite from touching
// posthog-js).
describe("telemetry without a key", () => {
  it("reports itself as unconfigured", () => {
    expect(isTelemetryConfigured()).toBe(false);
  });

  it("never throws from the public API", () => {
    expect(() => {
      identifyUser("u1");
      track("some_event", { a: 1 });
      captureError(new Error("boom"), { kind: "test" });
    }).not.toThrow();
  });
});
