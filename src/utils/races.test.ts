import { describe, it, expect, beforeAll } from "vitest";
import { detectAnyRace, bestTimesByDistance, isPersonalBest, findEdition, searchEditions, hydrateCatalogue, raceDateChanges } from "./races";
import type { CatalogueRace, Participation } from "../types";

type TestRaceCandidate = { editionId?: string; date: string; distanceKm: number };
type TestRun = { date?: string; km?: number } | null;
type TestParticipation = { status: string; distanceKm: number; timeSec: number | null };
type TestJoinedEdition = { raceId: string; name: string; edition: { date: string; distanceKm: number } };

const detectAny = detectAnyRace as unknown as (run: TestRun, candidates: TestRaceCandidate[]) => string | null;
const bestTimes = bestTimesByDistance as unknown as (participations: TestParticipation[]) => Record<number, number>;
const personalBest = isPersonalBest as unknown as (participation: TestParticipation, participations: TestParticipation[]) => boolean;
const find = findEdition as unknown as (editionId: string | null) => TestJoinedEdition | null;
const search = searchEditions as unknown as (query: string, today: string, options?: { upcomingOnly?: boolean }) => TestJoinedEdition[];

// The catalogue is now fetched data, not a bundle, so hydrate a tiny fixture
// before the lookup tests (mirrors what loadCatalogue does at runtime).
beforeAll(() => {
  hydrateCatalogue([
    {
      id: "behobia-san-sebastian", slug: "behobia-san-sebastian", name: "Behobia-San Sebastián", city: "San Sebastián",
      country: "ES", lat: 43.3183, lng: -1.9812, distances: [20], verified: true,
      editions: [{ id: "behobia-san-sebastian-2026-11-08", date: "2026-11-08", distanceKm: 20, elevation: 200, verified: true }],
    },
    {
      id: "berlin-marathon", slug: "berlin-marathon", name: "Berlin Marathon", city: "Berlin",
      country: "DE", lat: 52.5163, lng: 13.3777, distances: [42.2], verified: true,
      editions: [{ id: "berlin-marathon-2026-09-27", date: "2026-09-27", distanceKm: 42.2, elevation: 80, verified: true }],
    },
    {
      id: "paris-marathon", slug: "paris-marathon", name: "Paris Marathon", city: "Paris",
      country: "FR", lat: 48.8656, lng: 2.3212, distances: [42.2], verified: true,
      editions: [{ id: "paris-marathon-2027-04-11", date: "2027-04-11", distanceKm: 42.2, elevation: 60, verified: true }],
    },
  ]);
});

describe("detectAnyRace", () => {
  const cands = [
    { editionId: "main-20k", date: "2026-11-08", distanceKm: 20 },
    { editionId: "tuneup-10k", date: "2026-10-04", distanceKm: 10 },
  ];
  it("matches the correct race among several candidates", () => {
    expect(detectAny({ date: "2026-10-04", km: 10.2 }, cands)).toBe("tuneup-10k");
    expect(detectAny({ date: "2026-11-08", km: 19.5 }, cands)).toBe("main-20k");
  });
  it("returns null when no candidate matches (wrong date or wrong distance)", () => {
    expect(detectAny({ date: "2026-09-01", km: 10 }, cands)).toBeNull(); // no date match
    expect(detectAny({ date: "2026-10-04", km: 20 }, cands)).toBeNull(); // right day, wrong distance
  });
  it("ignores candidates without an editionId", () => {
    expect(detectAny({ date: "2026-10-04", km: 10 }, [{ date: "2026-10-04", distanceKm: 10 }])).toBeNull();
  });
  it("handles empty candidates / missing fields", () => {
    expect(detectAny({ date: "2026-10-04", km: 10 }, [])).toBeNull();
    expect(detectAny(null, cands)).toBeNull();
    expect(detectAny({ date: "2026-10-04" }, cands)).toBeNull();
  });
});

describe("bestTimesByDistance / isPersonalBest", () => {
  const parts = [
    { status: "done", distanceKm: 10, timeSec: 3000 },
    { status: "done", distanceKm: 10, timeSec: 2800 },
    { status: "done", distanceKm: 21.1, timeSec: 6000 },
    { status: "wishlist", distanceKm: 10, timeSec: null },
  ];
  it("keeps the fastest time per distance bucket", () => {
    expect(bestTimes(parts)).toEqual({ 10: 2800, 21.1: 6000 });
  });
  it("flags the fastest done entry as a PB", () => {
    expect(personalBest({ status: "done", distanceKm: 10, timeSec: 2800 }, parts)).toBe(true);
    expect(personalBest({ status: "done", distanceKm: 10, timeSec: 3000 }, parts)).toBe(false);
  });
  it("never flags a wishlist (no time) entry", () => {
    expect(personalBest({ status: "wishlist", distanceKm: 10, timeSec: null }, parts)).toBe(false);
  });
});

describe("findEdition", () => {
  it("resolves a known curated edition", () => {
    const e = find("behobia-san-sebastian-2026-11-08");
    expect(e?.name).toBe("Behobia-San Sebastián");
    expect(e?.edition.distanceKm).toBe(20);
  });
  it("returns null for an unknown / orphaned id", () => {
    expect(find("nope-2099")).toBeNull();
    expect(find(null)).toBeNull();
  });
});

describe("searchEditions", () => {
  const past = "1900-01-01";   // keep every curated edition in range
  const future = "2999-01-01"; // exclude every curated edition
  it("matches on race name (case-insensitive)", () => {
    const hits = search("berlin", past);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(e => e.name.toLowerCase().includes("berlin"))).toBe(true);
  });
  it("matches on city", () => {
    expect(search("paris", past).length).toBeGreaterThan(0);
  });
  it("returns joined editions usable as a promote target", () => {
    const [e] = search("berlin", past);
    expect(e!.raceId).toBeTruthy();
    expect(e!.edition.date).toBeTruthy();
    expect(e!.edition.distanceKm).toBeGreaterThan(0);
  });
  it("hides past editions by default", () => {
    expect(search("", future)).toHaveLength(0);
  });
  it("includes past editions when upcomingOnly is false", () => {
    expect(search("", future, { upcomingOnly: false }).length).toBeGreaterThan(0);
  });
  it("returns all upcoming editions for an empty query", () => {
    expect(search("", past).length).toBeGreaterThan(1);
  });
});

describe("raceDateChanges", () => {
  const TODAY = "2026-09-28";
  const cat: CatalogueRace[] = [
    { id: "paris", name: "ASICS Marathon de Paris", editions: [{ id: "paris-2027-04-11", date: "2027-04-04", distanceKm: 42.2 }] },
    { id: "bcn", name: "Mitja Barcelona", editions: [{ id: "bcn-2027-02-21", date: "2027-02-14", distanceKm: 21.1 }] },
    { id: "lyon", name: "Run in Lyon", editions: [{ id: "lyon-2026-11-29", date: "2026-10-04", distanceKm: 42.2 }] },
    { id: "old", name: "Old race", editions: [{ id: "old-2026-03-14", date: "2026-03-15", distanceKm: 21.1 }] },
  ];
  const wish = (editionId: string, raceDate: string, extra: Partial<Participation> = {}): Participation =>
    ({ editionId, raceDate, label: editionId, status: "wishlist", distanceKm: 42.2, ...extra });

  it("flags a wishlisted race whose catalogue date moved", () => {
    expect(raceDateChanges([wish("bcn-2027-02-21", "2027-02-21")], cat, {}, {}, TODAY)).toEqual([
      { editionId: "bcn-2027-02-21", label: "bcn-2027-02-21", oldDate: "2027-02-21", newDate: "2027-02-14", isTarget: false },
    ]);
  });

  it("compares the training target against the date the plan was built on", () => {
    const parts = [wish("paris-2027-04-11", "2027-04-04")];
    const [c] = raceDateChanges(parts, cat, { editionId: "paris-2027-04-11", raceDate: "2027-04-11" }, {}, TODAY);
    expect(c).toMatchObject({ oldDate: "2027-04-11", newDate: "2027-04-04", isTarget: true });
  });

  it("reports a target that has no participation, labelled from the catalogue", () => {
    const [c] = raceDateChanges([], cat, { editionId: "paris-2027-04-11", raceDate: "2027-04-11" }, {}, TODAY);
    expect(c).toMatchObject({ label: "ASICS Marathon de Paris 2027", isTarget: true });
  });

  it("still flags a race whose new date is already past but the planned one isn't", () => {
    expect(raceDateChanges([wish("lyon-2026-11-29", "2026-11-29")], cat, {}, {}, TODAY)).toHaveLength(1);
  });

  it("stays quiet when matching, acknowledged, done, fully past, or not in the catalogue", () => {
    expect(raceDateChanges([wish("bcn-2027-02-21", "2027-02-14")], cat, {}, {}, TODAY)).toEqual([]);
    expect(raceDateChanges([wish("bcn-2027-02-21", "2027-02-21")], cat, {}, { "bcn-2027-02-21": "2027-02-14" }, TODAY)).toEqual([]);
    expect(raceDateChanges([wish("bcn-2027-02-21", "2027-02-21", { status: "done" })], cat,
      { editionId: "bcn-2027-02-21", raceDate: "2027-02-21" }, {}, TODAY)).toEqual([]);
    expect(raceDateChanges([wish("old-2026-03-14", "2026-03-14")], cat, {}, {}, TODAY)).toEqual([]);
    expect(raceDateChanges([wish("gone-2027-01-01", "2027-01-01")], cat, {}, {}, TODAY)).toEqual([]);
    expect(raceDateChanges([wish("bcn-2027-02-21", "2027-02-21")], [], {}, {}, TODAY)).toEqual([]);
  });

  it("re-flags when the catalogue moves again after an acknowledgement", () => {
    expect(raceDateChanges([wish("bcn-2027-02-21", "2027-02-21")], cat, {}, { "bcn-2027-02-21": "2027-02-07" }, TODAY)).toHaveLength(1);
  });
});
