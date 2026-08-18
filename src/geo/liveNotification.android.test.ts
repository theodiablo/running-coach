import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunNotificationContent } from "../utils/runNotification";

// The Android path of the seam: what the patched background-geolocation plugin
// receives. Besides the text it needs the `live` seed, from which the foreground
// service keeps distance/pace current while the WebView is frozen in the
// background — drop a field here and the lock screen silently freezes again
// (docs/live-tracking.md). Separate file from liveNotification.test.ts because
// the platform mock is module-scoped.

const calls: Record<string, unknown>[] = [];

vi.mock("@capacitor/core", () => ({
  registerPlugin: (name: string) => {
    if (name === "BackgroundGeolocation") {
      return {
        updateNotification: (options: Record<string, unknown>) => {
          calls.push(options);
          return Promise.resolve({ updated: true });
        },
      };
    }
    return { push: () => Promise.reject(new Error("wrong platform")), end: () => Promise.resolve() };
  },
}));
vi.mock("../native", () => ({ isAndroid: true, isIos: false }));
vi.mock("../i18n", () => ({ t: (k: string) => k }));

const content = (over: Partial<RunNotificationContent> = {}): RunNotificationContent => ({
  titleKey: "title",
  message: "5.23 km · 5:42/km",
  chronometerStartMs: 1_700_000_000_000,
  live: { km: 5.234, paceSecPerKm: 342, hr: null, hrAtMs: null, tracking: true },
  ...over,
});

let seam: typeof import("./liveNotification");

beforeEach(async () => {
  calls.length = 0;
  vi.resetModules();
  seam = await import("./liveNotification");
});

describe("pushRunNotification on Android", () => {
  it("sends the display text and the live seed the service extrapolates from", () => {
    seam.pushRunNotification(content());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      title: "tracker.notif.title",
      message: "5.23 km · 5:42/km",
      chronometerStartMs: 1_700_000_000_000,
      km: 5.234,
      paceSecPerKm: 342,
      tracking: true,
    });
  });

  it("carries HR with the sample's timestamp, so a stale reading can be dropped", () => {
    seam.pushRunNotification(content({
      message: "5.23 km · 5:42/km · ♥ 152",
      live: { km: 5.234, paceSecPerKm: 342, hr: 152, hrAtMs: 1_700_000_050_000, tracking: true },
    }));
    expect(calls[0].hr).toBe(152);
    expect(calls[0].hrAtMs).toBe(1_700_000_050_000);
  });

  it("marks a paused run so the service stops counting fixes into the notification", () => {
    seam.pushRunNotification(content({
      titleKey: "pausedTitle",
      message: "30:00 · 5.23 km · 5:42/km",
      chronometerStartMs: null,
      live: { km: 5.234, paceSecPerKm: 342, hr: null, hrAtMs: null, tracking: false },
    }));
    expect(calls[0].tracking).toBe(false);
    expect(calls[0].chronometerStartMs).toBeUndefined();
  });

  it("re-sends text-identical content with a live HR reading before the native 90s staleness window (keep-alive)", async () => {
    vi.useFakeTimers();
    try {
      const withHr = content({
        message: "5.23 km · 5:42/km · ♥ 152",
        live: { km: 5.234, paceSecPerKm: 342, hr: 152, hrAtMs: 1_700_000_050_000, tracking: true },
      });
      seam.pushRunNotification(withHr);
      expect(calls).toHaveLength(1);

      // Steady pace/km/HR — a plain content-identity dedupe would drop this
      // silently, leaving the native seed's hrAtMs unrefreshed until it ages
      // out on its own 90s clock (BackgroundGeolocation.java LIVE_HR_STALE_MS).
      await vi.advanceTimersByTimeAsync(30_000);
      seam.pushRunNotification(withHr);
      expect(calls).toHaveLength(1); // still well within the keep-alive interval

      await vi.advanceTimersByTimeAsync(31_000); // 61s since the confirmed send
      seam.pushRunNotification(withHr);
      expect(calls).toHaveLength(2); // forced through before the native side would drop HR
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not force a keep-alive push once HR is no longer live", async () => {
    vi.useFakeTimers();
    try {
      const noHr = content({ message: "5.23 km · 5:42/km" });
      seam.pushRunNotification(noHr);
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(120_000);
      seam.pushRunNotification(noHr);
      expect(calls).toHaveLength(1); // nothing to keep alive — plain dedupe holds
    } finally {
      vi.useRealTimers();
    }
  });
});
