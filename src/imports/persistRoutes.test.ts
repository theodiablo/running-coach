import { describe, it, expect, vi, beforeEach } from "vitest";

// The route/HR persistence seam only — saveRoute is faked so this stays a unit
// test of what the save path hands to addRuns.
const { saveRoute, queuePendingRoute } = vi.hoisted(() => ({
  saveRoute: vi.fn(async () => "route-1"),
  queuePendingRoute: vi.fn(),
}));
vi.mock("../routes", () => ({ saveRoute, queuePendingRoute }));

import { persistImportedRoute } from "./persistRoutes";

beforeEach(() => {
  saveRoute.mockReset().mockResolvedValue("route-1");
  queuePendingRoute.mockReset();
});

describe("persistImportedRoute", () => {
  // The Run shape defines what may reach the synced blob; everything a provider
  // adds on the way through is transient and stops here. providerId joined
  // points/hrSamples when the import toast started naming its source.
  it("strips every transient field, on both the route and the no-route path", async () => {
    const withRoute = await persistImportedRoute({
      date: "2026-08-15", km: 8.2, durationSec: 3000,
      points: [[1, 2, 0, 10], [1.001, 2.001, 10, 12]],
      providerId: "suunto",
    });
    expect(withRoute).not.toHaveProperty("points");
    expect(withRoute).not.toHaveProperty("providerId");
    expect(withRoute.routeId).toBe("route-1");

    const plain = await persistImportedRoute({ date: "2026-08-15", km: 8.2, providerId: "suunto" });
    expect(plain).not.toHaveProperty("providerId");
    expect(plain).toEqual({ date: "2026-08-15", km: 8.2 });
    expect(saveRoute).toHaveBeenCalledTimes(1); // nothing to persist for the plain run
  });

  // A Health Connect session that carried an ExerciseRoute arrives here shaped
  // exactly like any other GPS import, so it must land on the ONE route path:
  // a run_routes row + routeId, with best efforts measured off the trace at save
  // time (the single extraction point every PB comparison later reads).
  it("measures best efforts from an imported Health Connect route", async () => {
    // ~1.1 km due north at ~5:33/km — long enough for a real 1k window.
    const points: [number, number, number, number][] = Array.from({ length: 11 }, (_, i) => [
      48.85 + i * 0.001, // ~111 m per step
      2.35,
      i * 33_000,
      35 + i,
    ]);
    const out = await persistImportedRoute({
      date: "2026-08-17", km: 1.1, durationSec: 330,
      source: "watch", hcId: "hc-session-1",
      points,
      hrSamples: [{ bpm: 148, t: 0 }, { bpm: 155, t: 33_000 }],
      providerId: "healthconnect",
    });
    expect(out.routeId).toBe("route-1");
    expect(out).not.toHaveProperty("hrRouteId"); // a GPS run rides routeId, not the HR sidecar
    expect(out).not.toHaveProperty("points");
    expect(out).not.toHaveProperty("hrSamples");
    // Extraction ran off the trace, not the whole-run estimate.
    expect(out.bestEfforts).toBeDefined();
    expect(out.bestEfforts!["1k"]).toBeGreaterThan(0);
    // Provenance survives so the run reads as a watch import with a map.
    expect(out.source).toBe("watch");
    expect(out.hcId).toBe("hc-session-1");
    // The HR stream still rides along, in the same route row's stats sidecar.
    const saved = (saveRoute.mock.calls[0] as unknown[])[0] as { points: unknown[]; stats: { hrSamples?: unknown } };
    expect(saved.stats.hrSamples).toEqual([{ bpm: 148, t: 0 }, { bpm: 155, t: 33_000 }]);
    expect(saved.points.length).toBeGreaterThan(0);
  });

  it("keeps an HR-only import off routeId and on the hrRouteId sidecar", async () => {
    const out = await persistImportedRoute({
      date: "2026-08-16", km: 8.1, durationSec: 3920,
      hrSamples: [{ bpm: 140, t: 0 }, { bpm: 150, t: 10 }],
      providerId: "healthconnect",
    });
    expect(out).not.toHaveProperty("hrSamples");
    expect(out).not.toHaveProperty("providerId");
    expect(out).not.toHaveProperty("routeId");
    expect(out.hrRouteId).toBe("route-1");
  });
});
