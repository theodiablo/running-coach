import { describe, it, expect } from "vitest";
import { daysUntil, hasTestRun, inRaceDayMode, upcomingRace, wishlistRaceCandidates } from "./raceDay";
import type { Participation, Plan, Run } from "../types";

const part = (p: Partial<Participation>): Participation => ({ status: "wishlist", ...p });

describe("inRaceDayMode", () => {
  it("is on for a live-first runner until a plan exists", () => {
    expect(inRaceDayMode({ liveFirst: true }, null)).toBe(true);
    expect(inRaceDayMode({ liveFirst: true }, { weeks: [] } as unknown as Plan)).toBe(false);
    expect(inRaceDayMode({}, null)).toBe(false);
  });
});

describe("upcomingRace", () => {
  const today = "2026-11-02";
  it("picks the earliest wishlisted race from today on", () => {
    const parts = [
      part({ editionId: "b", raceDate: "2026-12-01" }),
      part({ editionId: "a", raceDate: "2026-11-09" }),
      part({ editionId: "past", raceDate: "2026-10-01" }),
      part({ editionId: "done", raceDate: "2026-11-05", status: "done" }),
    ];
    expect(upcomingRace(parts, today)?.editionId).toBe("a");
  });
  it("counts a race today as upcoming", () => {
    expect(upcomingRace([part({ editionId: "t", raceDate: today })], today)?.editionId).toBe("t");
  });
  it("is null with nothing ahead", () => {
    expect(upcomingRace([part({ raceDate: "2026-10-01" })], today)).toBeNull();
    expect(upcomingRace(undefined, today)).toBeNull();
  });
});

describe("daysUntil", () => {
  it("counts whole days and clamps the past to zero", () => {
    expect(daysUntil("2026-11-09", "2026-11-02")).toBe(7);
    expect(daysUntil("2026-11-02", "2026-11-02")).toBe(0);
    expect(daysUntil("2026-10-30", "2026-11-02")).toBe(0);
  });
  it("is not thrown off by a DST change in between", () => {
    expect(daysUntil("2026-11-02", "2026-10-20")).toBe(13);
  });
});

describe("hasTestRun", () => {
  it("is true once any GPS run is logged", () => {
    expect(hasTestRun([{ source: "gps" } as Run])).toBe(true);
    expect(hasTestRun([{ source: "manual" } as Run])).toBe(false);
    expect(hasTestRun([])).toBe(false);
  });
});

describe("wishlistRaceCandidates", () => {
  it("keeps only wishlisted races that can be matched", () => {
    const parts = [
      part({ editionId: "ok", raceDate: "2026-11-09", distanceKm: 20 }),
      part({ editionId: "nodist", raceDate: "2026-11-09" }),
      part({ raceDate: "2026-11-09", distanceKm: 10 }),
      part({ editionId: "done", raceDate: "2026-11-09", distanceKm: 10, status: "done" }),
    ];
    expect(wishlistRaceCandidates(parts)).toEqual([{ editionId: "ok", date: "2026-11-09", distanceKm: 20 }]);
  });
});
