import { describe, it, expect, beforeEach, vi } from "vitest";

const getRoute = vi.fn();
vi.mock("./routes", () => ({ getRoute: (...args: unknown[]) => getRoute(...args) }));

import { backfillBestEfforts, backfillDone, runsNeedingBackfill, RUN_LIMIT } from "./bestEffortsBackfill";
import type { Run } from "./types";

const MARKER_KEY = "rc_best_efforts_backfill";

// A straight 2 km trace at 5:00/km — long enough to yield a 1K effort.
const trace = () => {
  const points = [];
  for (let i = 0; i <= 200; i++) points.push([0, (i * 10) / 111320, 1_700_000_000_000 + i * 3000, 0]);
  return { points };
};

const gpsRun = (id: string, extra: Partial<Run> = {}): Run =>
  ({ id, date: "2026-07-01", km: 2, durationSec: 600, routeId: "route-" + id, ...extra });

beforeEach(() => {
  localStorage.clear();
  getRoute.mockReset();
});

describe("runsNeedingBackfill", () => {
  it("takes only GPS runs that were never measured", () => {
    const runs: Run[] = [
      gpsRun("a"),
      gpsRun("b", { bestEfforts: { "1k": 300 } }),      // already measured
      gpsRun("c", { bestEfforts: {} }),                  // measured, covers nothing
      { id: "d", date: "2026-07-01", km: 5, durationSec: 1500 }, // no trace to measure
      { date: "2026-07-01", km: 5, routeId: "r", durationSec: 1500 }, // no id to patch
    ];
    expect(runsNeedingBackfill(runs).map(r => r.id)).toEqual(["a"]);
  });

  it("caps the pass at the newest RUN_LIMIT runs", () => {
    const runs = Array.from({ length: RUN_LIMIT + 15 }, (_, i) => gpsRun("r" + i));
    const picked = runsNeedingBackfill(runs);
    expect(picked).toHaveLength(RUN_LIMIT);
    // `runs` is newest-first, so the cap must keep the head of the list.
    expect(picked[0].id).toBe("r0");
  });
});

describe("backfillBestEfforts", () => {
  it("measures each candidate trace and marks the pass done", async () => {
    getRoute.mockResolvedValue(trace());
    const patches = await backfillBestEfforts([gpsRun("a")]);
    expect(patches).toHaveLength(1);
    expect(patches[0].id).toBe("a");
    expect(patches[0].bestEfforts["1k"]).toBeCloseTo(300, -1);
    expect(backfillDone()).toBe(true);
  });

  it("fetches points only, never the heavy stats sidecar", async () => {
    getRoute.mockResolvedValue(trace());
    await backfillBestEfforts([gpsRun("a")]);
    expect(getRoute).toHaveBeenCalledWith("route-a", false);
  });

  it("settles a missing or empty trace instead of retrying it forever", async () => {
    getRoute.mockResolvedValue(null);
    const patches = await backfillBestEfforts([gpsRun("a")]);
    expect(patches).toEqual([{ id: "a", bestEfforts: {} }]);
    expect(backfillDone()).toBe(true);
  });

  it("leaves the pass unmarked when a fetch fails, so an offline boot retries", async () => {
    getRoute.mockRejectedValue(new Error("offline"));
    expect(await backfillBestEfforts([gpsRun("a")])).toEqual([]);
    expect(backfillDone()).toBe(false);
  });

  it("keeps what it did measure even when a later run fails", async () => {
    getRoute.mockResolvedValueOnce(trace()).mockRejectedValueOnce(new Error("offline"));
    const patches = await backfillBestEfforts([gpsRun("a"), gpsRun("b")]);
    expect(patches.map(p => p.id)).toEqual(["a"]);
    expect(backfillDone()).toBe(false);
  });

  it("marks done without fetching anything when there is nothing to measure", async () => {
    expect(await backfillBestEfforts([])).toEqual([]);
    expect(getRoute).not.toHaveBeenCalled();
    expect(backfillDone()).toBe(true);
  });
});

describe("backfillDone", () => {
  it("is false before a pass and true after the marker is written", () => {
    expect(backfillDone()).toBe(false);
    localStorage.setItem(MARKER_KEY, "1");
    expect(backfillDone()).toBe(true);
  });

  it("ignores a marker from a different version", () => {
    localStorage.setItem(MARKER_KEY, "0");
    expect(backfillDone()).toBe(false);
  });

  it("reads as done when localStorage is unavailable, rather than refetching every boot", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(backfillDone()).toBe(true);
    spy.mockRestore();
  });
});
