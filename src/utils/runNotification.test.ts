import { describe, expect, it } from "vitest";
import { buildRunNotificationContent, sameNotificationContent } from "./runNotification";

const NOW = 1_700_000_000_000;

const base = {
  state: "tracking" as const,
  km: 5.234,
  paceSecPerKm: 342, // 5:42
  hr: null,
  movingMs: 1_800_000, // 30:00
  nowMs: NOW,
};

describe("buildRunNotificationContent", () => {
  it("formats a tracking update with an OS-chronometer anchor at now - movingMs", () => {
    const c = buildRunNotificationContent(base);
    expect(c.titleKey).toBe("title");
    expect(c.message).toBe("5.23 km · 5:42/km");
    // The anchor makes the OS render exactly the moving time — the load-bearing
    // property: the clock ticks natively, with zero JS pushes.
    expect(c.chronometerStartMs).toBe(NOW - base.movingMs);
  });

  it("appends live HR when present and omits it when absent", () => {
    expect(buildRunNotificationContent({ ...base, hr: 152 }).message).toBe("5.23 km · 5:42/km · ♥ 152");
    expect(buildRunNotificationContent({ ...base, hr: 0 }).message).toBe("5.23 km · 5:42/km");
  });

  it("shows placeholders before GPS warms up instead of bogus numbers", () => {
    const c = buildRunNotificationContent({ ...base, km: 0, paceSecPerKm: 0 });
    expect(c.message).toBe("0.00 km · --:--/km");
  });

  it("freezes the clock into the text while paused (no chronometer)", () => {
    const c = buildRunNotificationContent({ ...base, state: "paused" });
    expect(c.titleKey).toBe("pausedTitle");
    expect(c.chronometerStartMs).toBeNull();
    expect(c.message).toBe("30:00 · 5.23 km · 5:42/km");
  });

  it("seeds the native renderer with the numbers behind the text", () => {
    expect(buildRunNotificationContent({ ...base, hr: 152, hrAt: NOW - 900 }).live).toEqual({
      km: 5.234, paceSecPerKm: 342, hr: 152, hrAtMs: NOW - 900, tracking: true,
    });
    // Paused: the service must stop folding fixes into the distance.
    expect(buildRunNotificationContent({ ...base, state: "paused" }).live.tracking).toBe(false);
  });
});

describe("sameNotificationContent", () => {
  const c = buildRunNotificationContent(base);

  it("never matches an empty previous state", () => {
    expect(sameNotificationContent(null, c)).toBe(false);
    expect(sameNotificationContent(undefined, c)).toBe(false);
  });

  it("treats chronometer rounding jitter as unchanged while tracking", () => {
    // Same content pushed 2s later: now and movingMs advanced together, the
    // anchor only moved by sub-second rounding.
    const later = buildRunNotificationContent({ ...base, nowMs: NOW + 2000, movingMs: base.movingMs + 1600 });
    expect(later.message).toBe(c.message);
    expect(sameNotificationContent(c, later)).toBe(true);
  });

  it("detects a genuine re-anchor (resume shifted the base past the tolerance)", () => {
    // 60s pause: now advanced 60s, movingMs did not → anchor shifted by 60s.
    const resumed = buildRunNotificationContent({ ...base, nowMs: NOW + 60_000 });
    expect(sameNotificationContent(c, resumed)).toBe(false);
  });

  it("detects data changes and state transitions", () => {
    expect(sameNotificationContent(c, buildRunNotificationContent({ ...base, km: 5.31 }))).toBe(false);
    expect(sameNotificationContent(c, buildRunNotificationContent({ ...base, hr: 149 }))).toBe(false);
    expect(sameNotificationContent(c, buildRunNotificationContent({ ...base, state: "paused" }))).toBe(false);
  });
});
