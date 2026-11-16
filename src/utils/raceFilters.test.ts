import { describe, expect, it } from "vitest";
import {
  ANY_DISTANCE, DEFAULT_FILTERS, LAST_STOP, activeFilterCount, kmInRange, matchingEditions, nearestStop,
  rangeKm, readFilters, searchParams, whenUntil,
} from "./raceFilters";
import type { CatalogueRace } from "../types";

describe("distance range", () => {
  it("is unbounded at either end of the scale", () => {
    expect(rangeKm(ANY_DISTANCE)).toEqual({ minKm: null, maxKm: null });
    expect(rangeKm({ min: 2, max: 4 })).toEqual({ minKm: 10, maxKm: 21.1 });
    expect(rangeKm({ min: 6, max: LAST_STOP })).toEqual({ minKm: 42.2, maxKm: null });
  });
  it("keeps a 21 km race on the half stop, as the server does", () => {
    const half = { min: 4, max: 4 };
    expect(kmInRange(21, half)).toBe(true);
    expect(kmInRange(15, half)).toBe(false);
  });
  it("snaps a plan distance to its nearest stop", () => {
    expect(nearestStop(21.0975)).toBe(4);
    expect(nearestStop(42.195)).toBe(6);
    expect(nearestStop(8)).toBe(2);
  });
});

describe("searchParams", () => {
  const today = new Date("2026-11-16T10:00:00");
  it("sends Near me only with a fix, and coarse sorting only then", () => {
    const f = { ...DEFAULT_FILTERS, near: true, sort: "distance" as const };
    expect(searchParams("", f, null, today)).toMatchObject({ near: null, radiusKm: null, sort: "date" });
    expect(searchParams(" valencia ", f, { lat: 39.47, lng: -0.37 }, today))
      .toMatchObject({ query: "valencia", near: { lat: 39.47, lng: -0.37 }, radiusKm: 100, sort: "distance" });
  });
  it("turns the when window into an end date", () => {
    expect(searchParams("", { ...DEFAULT_FILTERS, when: 3 }, null, today).to).toBe("2027-02-16");
    expect(whenUntil(null)).toBeNull();
  });
});

describe("matchingEditions", () => {
  const race = { id: "r", name: "R", editions: [
    { id: "a", date: "2026-10-01", distanceKm: 10 },
    { id: "b", date: "2027-03-01", distanceKm: 42.2 },
    { id: "c", date: "2026-12-01", distanceKm: 10 },
  ] } as CatalogueRace;
  it("leads with the soonest upcoming edition that answers the filters", () => {
    expect(matchingEditions(race, DEFAULT_FILTERS, "2026-11-16").map(e => e.id)).toEqual(["c", "b"]);
    expect(matchingEditions(race, { ...DEFAULT_FILTERS, distance: { min: 6, max: 6 } }, "2026-11-16").map(e => e.id)).toEqual(["b"]);
  });
  it("falls back to the latest past edition for a race with none ahead", () => {
    expect(matchingEditions(race, DEFAULT_FILTERS, "2027-06-01").map(e => e.id)).toEqual(["b", "c", "a"]);
  });
});

describe("stored filters", () => {
  it("restores what was saved, but never Near me (it needs a fresh fix)", () => {
    const f = readFilters(JSON.stringify({ distance: { min: 2, max: 4 }, terrain: "trail", when: 6, country: "ES", verifiedOnly: true, near: true, radius: 50 }));
    expect(f).toMatchObject({ distance: { min: 2, max: 4 }, terrain: "trail", when: 6, country: "ES", verifiedOnly: true, near: false, radius: 50 });
    expect(activeFilterCount(f)).toBe(5);
  });
  it("drops anything malformed", () => {
    expect(readFilters("{not json")).toEqual(DEFAULT_FILTERS);
    expect(readFilters(JSON.stringify({ distance: { min: 5, max: 2 }, when: 7, country: "Spain", terrain: "sand" }))).toEqual(DEFAULT_FILTERS);
  });
});
