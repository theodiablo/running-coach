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
  readExerciseRoute: vi.fn(),
};
vi.mock("./plugin", () => ({ getWatchImportPlugin: () => plugin }));

import { scanWatchSessions, getSeenIds, markSeen, hasWatchAuthorization } from "./import";
import { getScanLog } from "./scanLog";

const grant = () => localStorage.setItem(WATCH_HC_AUTH_KEY, "1");

beforeEach(() => {
  localStorage.clear();
  plugin.checkAvailability.mockReset().mockResolvedValue({ availability: "Available" });
  plugin.checkHealthPermissions.mockReset().mockResolvedValue({ granted: true });
  plugin.readExerciseSessions.mockReset().mockResolvedValue({ sessions: [] });
  plugin.readHeartRateSeries.mockReset().mockResolvedValue({ samples: [] });
  // The realistic default: exercise routes are a separate grant the app can't
  // ask for, so most devices answer "consent-required" with no points.
  plugin.readExerciseRoute.mockReset().mockResolvedValue({ status: "consent-required", points: [] });
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

describe("scanWatchSessions exercise routes", () => {
  const oneRunnableSession = {
    sessions: [{ id: "a", startTime: "2026-07-10T08:00:00Z", endTime: "2026-07-10T08:40:00Z", exerciseType: 56, distanceM: 8000, startZoneOffsetSec: 0 }],
  };

  it("attaches a returned route as transient points, keyed by session id", async () => {
    grant();
    plugin.readExerciseSessions.mockResolvedValue(oneRunnableSession);
    plugin.readExerciseRoute.mockResolvedValue({
      status: "data",
      points: [[48.85, 2.35, 1000, 35], [48.86, 2.36, 3000, 37]],
    });
    const out = await scanWatchSessions([], { enabled: true });
    expect(plugin.readExerciseRoute).toHaveBeenCalledWith({ id: "a" });
    // [lat, lng, t, alt] — the same tuple a recorded run stores, so
    // persistImportedRoute can simplify it into a run_routes row unchanged.
    expect((out[0] as { points?: unknown }).points).toEqual([
      [48.85, 2.35, 1000, 35],
      [48.86, 2.36, 3000, 37],
    ]);
  });

  it("drops malformed points rather than importing a broken trace", async () => {
    grant();
    plugin.readExerciseSessions.mockResolvedValue(oneRunnableSession);
    plugin.readExerciseRoute.mockResolvedValue({
      status: "data",
      points: [[48.85, 2.35, 1000, null], ["x", 2.36, 3000, 1], [48.87, 2.37, 5000]],
    });
    const out = await scanWatchSessions([], { enabled: true });
    expect((out[0] as { points?: unknown }).points).toEqual([
      [48.85, 2.35, 1000, null],
      [48.87, 2.37, 5000, null],
    ]);
  });

  // The core degradation guarantee: routes are a separate, more sensitive grant
  // the app cannot request, so a refusal must land exactly on today's behaviour.
  it.each([
    ["consent denied", { status: "consent-required", points: [] }],
    ["no route on the session", { status: "none", points: [] }],
    ["read unavailable", { status: "unavailable", points: [] }],
  ])("still imports the run with no map when the route read reports %s", async (_label, routeRes) => {
    grant();
    plugin.readExerciseSessions.mockResolvedValue(oneRunnableSession);
    plugin.readHeartRateSeries.mockResolvedValue({ samples: [{ bpm: 150, t: 1000 }] });
    plugin.readExerciseRoute.mockResolvedValue(routeRes);
    const out = await scanWatchSessions([], { enabled: true });
    expect(out.map(r => r.hcId)).toEqual(["a"]);
    expect(out[0].km).toBe(8);
    expect((out[0] as { points?: unknown }).points).toBeUndefined();
    // HR enrichment is untouched by a refused route.
    expect((out[0] as { hrSamples?: unknown }).hrSamples).toEqual([{ bpm: 150, t: 1000 }]);
  });

  it("still imports the run when the route read throws", async () => {
    grant();
    plugin.readExerciseSessions.mockResolvedValue(oneRunnableSession);
    plugin.readExerciseRoute.mockRejectedValue(new Error("no route permission"));
    const out = await scanWatchSessions([], { enabled: true });
    expect(out.map(r => r.hcId)).toEqual(["a"]);
    expect((out[0] as { points?: unknown }).points).toBeUndefined();
  });

  // routes:false is the NORMAL state of a working connection — Health Connect
  // ignores app requests for the route scope. It must never gate the import.
  it("never treats a missing route grant as a broken connection", async () => {
    grant();
    plugin.checkHealthPermissions.mockResolvedValue({ granted: true, routes: false });
    plugin.readExerciseSessions.mockResolvedValue(oneRunnableSession);
    const out = await scanWatchSessions([], { enabled: true });
    expect(out.map(r => r.hcId)).toEqual(["a"]);
    expect(hasWatchAuthorization()).toBe(true);
  });

  // A lone fix is not a trace: routeId is what History gates the map button on,
  // so a one-point route must stay on the HR sidecar instead of promising a map
  // that renders a single dot.
  it("ignores a route too short to be a trace", async () => {
    grant();
    plugin.readExerciseSessions.mockResolvedValue(oneRunnableSession);
    plugin.readExerciseRoute.mockResolvedValue({ status: "data", points: [[48.85, 2.35, 1000, null]] });
    const out = await scanWatchSessions([], { enabled: true });
    expect(out.map(r => r.hcId)).toEqual(["a"]);
    expect((out[0] as { points?: unknown }).points).toBeUndefined();
  });

  // Pins the routeStatuses ↔ imported-run alignment. Every other route test uses
  // a single session, which cannot catch a reordering or a filtered-out status.
  it("keeps route statuses aligned with the imported runs across a mixed batch", async () => {
    grant();
    plugin.readExerciseSessions.mockResolvedValue({
      sessions: [
        { id: "a", startTime: "2026-07-10T08:00:00Z", endTime: "2026-07-10T08:40:00Z", exerciseType: 56, distanceM: 8000, startZoneOffsetSec: 0 },
        { id: "b", startTime: "2026-07-11T08:00:00Z", endTime: "2026-07-11T08:40:00Z", exerciseType: 56, distanceM: 9000, startZoneOffsetSec: 0 },
        { id: "c", startTime: "2026-07-12T08:00:00Z", endTime: "2026-07-12T08:40:00Z", exerciseType: 56, distanceM: 7000, startZoneOffsetSec: 0 },
      ],
    });
    plugin.readExerciseRoute.mockImplementation(async ({ id }: { id: string }) =>
      id === "b"
        ? { status: "data", points: [[48.85, 2.35, 1000, null], [48.86, 2.36, 3000, null]] }
        : { status: "consent-required", points: [] });
    const out = await scanWatchSessions([], { enabled: true });
    expect(out.map(r => r.hcId)).toEqual(["a", "b", "c"]);
    // Only the session that actually had a route carries points.
    expect(out.map(r => !!(r as { points?: unknown }).points)).toEqual([false, true, false]);
    // …and the diagnostics agree, in the same order.
    const last = getScanLog().at(-1)!;
    expect(last.routeStatuses).toEqual(["consent-required", "data", "consent-required"]);
    expect(last.importedCount).toBe(3);
  });

  it("records the separate route grant, and omits statuses when nothing imported", async () => {
    grant();
    plugin.checkHealthPermissions.mockResolvedValue({ granted: true, routes: true });
    plugin.readExerciseSessions.mockResolvedValue({ sessions: [] });
    await scanWatchSessions([], { enabled: true });
    const last = getScanLog().at(-1)!;
    expect(last.routesGranted).toBe(true);
    expect(last.routeStatuses).toBeUndefined(); // nothing imported → nothing to report
  });

  it("reads no route for a session that was skipped as a duplicate", async () => {
    grant();
    plugin.readExerciseSessions.mockResolvedValue(oneRunnableSession);
    await scanWatchSessions([{ id: "r1", date: "2026-07-10", km: 8, hcId: "a" }], { enabled: true });
    expect(plugin.readExerciseRoute).not.toHaveBeenCalled();
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
