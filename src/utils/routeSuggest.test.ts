import { describe, it, expect } from "vitest";
import {
  characterFromWaytypes,
  selfOverlapPct,
  parseLoopCandidates,
  acceptable,
  rankCandidates,
  overlapWithHistory,
} from "./routeSuggest";
import type { SuggestedRoute } from "../types";

// A ~square loop near Lyon (approx), returned as ORS [lng, lat, ele] tuples.
// ~0.009° ≈ 1 km at this latitude, so the square is roughly 4 km round.
function squareLoopCoords(): [number, number, number][] {
  const lat = 45.75, lng = 4.85, d = 0.009, ele = 200;
  return [
    [lng, lat, ele],
    [lng + d, lat, ele + 5],
    [lng + d, lat + d, ele + 10],
    [lng, lat + d, ele + 4],
    [lng, lat, ele], // back to start
  ];
}

function feature(coords: [number, number, number][], waytypesSummary?: unknown) {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: { extras: waytypesSummary ? { waytypes: { summary: waytypesSummary } } : undefined },
  };
}

describe("characterFromWaytypes", () => {
  it("buckets a mostly-path route", () => {
    expect(characterFromWaytypes([{ value: 7, amount: 70 }, { value: 3, amount: 30 }])).toBe("mostlyPaths");
  });
  it("buckets a mixed route", () => {
    expect(characterFromWaytypes([{ value: 4, amount: 30 }, { value: 3, amount: 70 }])).toBe("mixed");
  });
  it("buckets a mostly-street route", () => {
    expect(characterFromWaytypes([{ value: 3, amount: 90 }, { value: 7, amount: 10 }])).toBe("mostlyStreets");
  });
  it("returns undefined without way-type data", () => {
    expect(characterFromWaytypes(undefined)).toBeUndefined();
    expect(characterFromWaytypes(null)).toBeUndefined();
    expect(characterFromWaytypes("nope")).toBeUndefined();
  });
});

describe("selfOverlapPct", () => {
  it("is ~0 for a clean loop (start/finish closure excluded)", () => {
    const pts = squareLoopCoords().map<[number, number, number]>(c => [c[1], c[0], c[2]]);
    expect(selfOverlapPct(pts)).toBeLessThan(0.1);
  });
  it("is high for an out-and-back", () => {
    // Walk out along a line and straight back over the same points.
    const out: [number, number, number][] = [];
    for (let i = 0; i <= 10; i++) out.push([45.75 + i * 0.0005, 4.85, 200]);
    const back = out.slice(0, -1).reverse();
    expect(selfOverlapPct([...out, ...back])).toBeGreaterThan(0.5);
  });
});

describe("parseLoopCandidates", () => {
  it("decodes [lng,lat,ele] to measured loop candidates", () => {
    const routes = parseLoopCandidates([feature(squareLoopCoords(), [{ value: 7, amount: 80 }])], 0);
    expect(routes).toHaveLength(1);
    const r = routes[0];
    expect(r.id).toBe("sr0");
    // ~4 km square; measured via distanceKm, allow generous tolerance.
    expect(r.km).toBeGreaterThan(3);
    expect(r.km).toBeLessThan(5);
    expect(r.character).toBe("mostlyPaths");
    expect(r.points[0][0]).toBeCloseTo(45.75, 3); // lat first now
    expect(typeof r.overlapPct).toBe("number");
  });

  it("seeds stable ids from seedBase", () => {
    const routes = parseLoopCandidates([feature(squareLoopCoords()), feature(squareLoopCoords())], 3);
    expect(routes.map(r => r.id)).toEqual(["sr3", "sr4"]);
  });

  it("skips malformed features and non-arrays", () => {
    expect(parseLoopCandidates(null, 0)).toEqual([]);
    expect(parseLoopCandidates([{}, { geometry: {} }, feature([[4.85, 45.75, 1]])], 0)).toEqual([]);
  });
});

describe("acceptable / rankCandidates", () => {
  const mk = (km: number, overlapPct: number, elevation = 20): SuggestedRoute => ({
    id: "x", points: [], km, elevation, overlapPct,
  });

  it("rejects loops too far from target length", () => {
    expect(acceptable(mk(5, 0), 5)).toBe(true);
    expect(acceptable(mk(7, 0), 5)).toBe(false); // 40% over
  });
  it("rejects heavy self-overlap", () => {
    expect(acceptable(mk(5, 0.6), 5)).toBe(false);
  });
  it("respects a flat elevation preference", () => {
    expect(acceptable({ id: "a", points: [], km: 5, elevation: 100, overlapPct: 0 }, 5, "flat")).toBe(false);
    expect(acceptable({ id: "a", points: [], km: 5, elevation: 20, overlapPct: 0 }, 5, "flat")).toBe(true);
  });

  it("ranks the closest, cleanest loop first and annotates length error", () => {
    const ranked = rankCandidates([mk(7, 0), mk(5, 0.05), mk(6, 0)], 5);
    expect(ranked[0].km).toBe(5);
    expect(ranked[0].lengthErrorPct).toBeCloseTo(0, 5);
  });
});

describe("overlapWithHistory", () => {
  const line: [number, number, number | null][] = Array.from({ length: 10 }, (_, i) => [45.75 + i * 0.001, 4.85, null]);
  it("is 0 against empty history or far-away history", () => {
    expect(overlapWithHistory(line, [])).toBe(0);
    expect(overlapWithHistory(line, [[40, 2, null]])).toBe(0);
  });
  it("is 1 when the candidate retraces a recorded route", () => {
    expect(overlapWithHistory(line, line)).toBe(1);
  });
  it("is partial when only some points coincide", () => {
    const half = line.slice(0, 5);
    expect(overlapWithHistory(line, half)).toBeCloseTo(0.5, 5);
  });
});
