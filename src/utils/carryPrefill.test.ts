import { describe, expect, it } from "vitest";
import { carryPrefill } from "./carryPrefill";

describe("carryPrefill", () => {
  it("carries everything the form can't edit", () => {
    expect(carryPrefill({
      source: "gps", routeId: "r1", bestEfforts: { "5k": 1200 },
      hrRouteId: "h1", hcId: "hc1", extId: "suunto:1", startedAt: "2026-08-23T06:00:00.000Z",
      hrPending: { start: 1, end: 2, source: "healthconnect" },
    })).toEqual({
      source: "gps", routeId: "r1", bestEfforts: { "5k": 1200 },
      hrRouteId: "h1", hcId: "hc1", extId: "suunto:1", startedAt: "2026-08-23T06:00:00.000Z",
      hrPending: { start: 1, end: 2, source: "healthconnect" },
    });
  });

  // The field the old allowlist dropped, from both recorders.
  it("carries hrCoverage, which the old allowlist dropped", () => {
    expect(carryPrefill({ source: "gps", hrCoverage: 0.94 }).hrCoverage).toBe(0.94);
  });

  it("leaves the fields the form owns to the form", () => {
    expect(carryPrefill({
      date: "2026-08-23", type: "OTHER", activity: "bike", km: 10, durationSec: 3000,
      hr: 150, hrMax: 175, elevation: 100, effort: 3, notes: "hi", routeId: "r1",
    })).toEqual({ routeId: "r1" });
  });

  it("drops navigation state that isn't run data", () => {
    expect(carryPrefill({ pace: 300, wNum: 2, sId: "w2d4", id: "old" })).toEqual({});
  });

  it("skips null and undefined rather than storing them", () => {
    expect(carryPrefill({ hrPending: null, extId: undefined, routeId: "r1" })).toEqual({ routeId: "r1" });
  });

  it("marks a queued trace pending", () => {
    expect(carryPrefill({ routeTmp: "rt1" })).toEqual({ routeTmp: "rt1", routePending: true });
  });

  it("returns nothing for a hand-entered run", () => {
    expect(carryPrefill(null)).toEqual({});
  });
});
