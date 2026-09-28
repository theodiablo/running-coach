// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const init = vi.fn();
const posthog = {
  init,
  register: vi.fn(),
  set_config: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  has_opted_out_capturing: vi.fn(() => false),
  identify: vi.fn(),
  reset: vi.fn(),
  capture: vi.fn(),
  captureException: vi.fn(),
};
vi.mock("posthog-js", () => ({ default: posthog }));

// The adapter reads its key at module load, so each test gets a fresh, keyed copy.
async function load() {
  vi.resetModules();
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_test");
  return import("./index");
}

const initOptions = async () => {
  await vi.waitFor(() => expect(init).toHaveBeenCalledTimes(1));
  return init.mock.calls[0][1] as Record<string, unknown>;
};

describe("public-page telemetry (cookieless)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("counts pageviews with no consent, storing nothing on the device", async () => {
    const t = await load();
    t.initPublicPageTelemetry();
    const opts = await initOptions();
    expect(opts).toMatchObject({
      cookieless_mode: "always",
      persistence: "memory",
      capture_pageview: true,
      autocapture: false,
      disable_session_recording: true,
    });
    expect(opts).not.toHaveProperty("opt_out_capturing_by_default");
    expect(localStorage.length).toBe(0);
  });

  it("honours an explicit decline made in this browser", async () => {
    localStorage.setItem("rc_telemetry_consent_v2", "0");
    const t = await load();
    t.initPublicPageTelemetry();
    await new Promise((r) => setTimeout(r, 0));
    expect(init).not.toHaveBeenCalled();
  });

  it("never sends app events or an identity from the public page", async () => {
    const t = await load();
    t.initPublicPageTelemetry();
    await initOptions();
    t.track("run_logged", {});
    t.identifyUser("u1");
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(posthog.identify).not.toHaveBeenCalled();
  });

  it("leaves the app's opt-in SDK unchanged", async () => {
    localStorage.setItem("rc_telemetry_consent_v2", "1");
    const t = await load();
    t.initTelemetry();
    const opts = await initOptions();
    expect(opts).toMatchObject({ opt_out_capturing_by_default: true, capture_pageview: true });
    expect(opts).not.toHaveProperty("cookieless_mode");
  });
});
