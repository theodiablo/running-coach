import { describe, it, expect, beforeAll } from "vitest";
import { detectAnyRace, bestTimesByDistance, isPersonalBest, findEdition, searchEditions, hydrateCatalogue } from "./races";

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
