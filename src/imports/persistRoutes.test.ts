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
