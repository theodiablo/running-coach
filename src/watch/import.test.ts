// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from "vitest";
import { WATCH_HC_AUTH_KEY, WATCH_SEEN_MAX } from "../constants";

// Force the native path on and stub the bridge so nothing touches a real plugin.
vi.mock("../native", () => ({ isNative: true, isAndroid: true, isIos: false, platform: "android" }));
const plugin = {
  checkAvailability: vi.fn(),
  checkHealthPermissions: vi.fn(),
  requestHealthPermissions: vi.fn(),
  readExerciseSessions: vi.fn(),
  readHeartRateSeries: vi.fn(),
};
vi.mock("./plugin", () => ({ getWatchImportPlugin: () => plugin }));

import { scanWatchSessions, getSeenIds, markSeen, hasWatchAuthorization } from "./import";

const grant = () => localStorage.setItem(WATCH_HC_AUTH_KEY, "1");

beforeEach(() => {
  localStorage.clear();
  plugin.checkAvailability.mockReset().mockResolvedValue({ availability: "Available" });
  plugin.checkHealthPermissions.mockReset().mockResolvedValue({ granted: true });
  plugin.readExerciseSessions.mockReset().mockResolvedValue({ sessions: [] });
  plugin.readHeartRateSeries.mockReset().mockResolvedValue({ samples: [] });
});

describe("scanWatchSessions gating", () => {
  it("returns [] and never touches the bridge when disabled", async () => {
    grant();
    const out = await scanWatchSessions([], { enabled: false });
    expect(out).toEqual([]);
    expect(plugin.checkAvailability).not.toHaveBeenCalled();
  });

  it("returns [] and never touches the bridge when native reads are deferred", async () => {
    grant();
    const out = await scanWatchSessions([], { allowNativeRead: false });
    expect(out).toEqual([]);
    expect(plugin.checkAvailability).not.toHaveBeenCalled();
  });

  it("returns [] and never touches the bridge without the local grant marker", async () => {
    const out = await scanWatchSessions([], { enabled: true });
    expect(out).toEqual([]);
    expect(plugin.checkAvailability).not.toHaveBeenCalled();
  });

  it("clears the local marker when permission has been revoked", async () => {
    grant();
    plugin.checkHealthPermissions.mockResolvedValue({ granted: false });
    const out = await scanWatchSessions([], { enabled: true });
    expect(out).toEqual([]);
    expect(hasWatchAuthorization()).toBe(false);
  });
});

describe("scanWatchSessions reading", () => {
  it("maps new runnable sessions and drops short/duplicate/non-run ones", async () => {
    grant();
    plugin.readExerciseSessions.mockResolvedValue({
      sessions: [
        { id: "a", startTime: "2026-07-10T08:00:00Z", endTime: "2026-07-10T08:40:00Z", exerciseType: 56, distanceM: 8000, startZoneOffsetSec: 0 },
        { id: "b", startTime: "2026-07-09T08:00:00Z", endTime: "2026-07-09T08:02:00Z", exerciseType: 56, distanceM: 200, startZoneOffsetSec: 0 }, // < 0.5km
        { id: "c", startTime: "2026-07-08T08:00:00Z", endTime: "2026-07-08T09:00:00Z", exerciseType: 8, distanceM: 20000, startZoneOffsetSec: 0 }, // biking
      ],
    });
    const out = await scanWatchSessions([], { enabled: true });
    expect(out.map(r => r.hcId)).toEqual(["a"]);
    expect(out[0].km).toBe(8);
  });

  it("skips a session already present as a run (hcId dedupe)", async () => {
    grant();
    plugin.readExerciseSessions.mockResolvedValue({
      sessions: [{ id: "a", startTime: "2026-07-10T08:00:00Z", endTime: "2026-07-10T08:40:00Z", exerciseType: 56, distanceM: 8000, startZoneOffsetSec: 0 }],
    });
    const out = await scanWatchSessions([{ id: "r1", date: "2026-07-10", km: 8, hcId: "a" }], { enabled: true });
    expect(out).toEqual([]);
  });

  it("never throws on a bridge failure", async () => {
    grant();
    plugin.readExerciseSessions.mockRejectedValue(new Error("boom"));
    const out = await scanWatchSessions([], { enabled: true });
    expect(out).toEqual([]);
  });

  it("attaches the cleaned HR series to an imported run, origin-filtered to the writer", async () => {
    grant();
    plugin.readExerciseSessions.mockResolvedValue({
      sessions: [{ id: "a", startTime: "2026-07-10T08:00:00Z", endTime: "2026-07-10T08:40:00Z", exerciseType: 56, distanceM: 8000, startZoneOffsetSec: 0, dataOrigin: "com.garmin.android.apps.connectmobile" }],
    });
    plugin.readHeartRateSeries.mockResolvedValue({ samples: [{ bpm: 150, t: 1000 }, { bpm: 0, t: 2000 }] }); // 0-bpm dropped by normalize
    const out = await scanWatchSessions([], { enabled: true });
    expect(out).toHaveLength(1);
    expect((out[0] as { hrSamples?: unknown }).hrSamples).toEqual([{ bpm: 150, t: 1000 }]);
    expect(plugin.readHeartRateSeries).toHaveBeenCalledWith(
      expect.objectContaining({ startTime: "2026-07-10T08:00:00Z", endTime: "2026-07-10T08:40:00Z", dataOrigin: "com.garmin.android.apps.connectmobile" }),
    );
  });

  it("keeps the imported run (with its HR aggregates) when the HR-series read fails", async () => {
    grant();
    plugin.readExerciseSessions.mockResolvedValue({
      sessions: [{ id: "a", startTime: "2026-07-10T08:00:00Z", endTime: "2026-07-10T08:40:00Z", exerciseType: 56, distanceM: 8000, startZoneOffsetSec: 0 }],
    });
    plugin.readHeartRateSeries.mockRejectedValue(new Error("no perm"));
    const out = await scanWatchSessions([], { enabled: true });
    expect(out.map(r => r.hcId)).toEqual(["a"]);
    expect((out[0] as { hrSamples?: unknown }).hrSamples).toBeUndefined();
  });
});

describe("seen ids", () => {
  it("dedupes and caps the stored list", () => {
    markSeen(["x", "x", "y"]);
    expect(getSeenIds()).toEqual(["x", "y"]);
    markSeen(Array.from({ length: WATCH_SEEN_MAX + 50 }, (_, i) => "id" + i));
    expect(getSeenIds()).toHaveLength(WATCH_SEEN_MAX);
    // Oldest dropped: the last id is always retained.
    expect(getSeenIds()).toContain("id" + (WATCH_SEEN_MAX + 49));
  });
});
