import { describe, it, expect } from "vitest";
import { haversineM } from "./geo";
import {
  characterFromSurface,
  selfOverlapPct,
  parseLoopCandidates,
  rankCandidates,
  overlapWithHistory,
  historyNearCandidates,
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

function feature(coords: [number, number, number][], surfaceSummary?: unknown) {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: { extras: surfaceSummary ? { surface: { summary: surfaceSummary } } : undefined },
  };
}

describe("characterFromSurface", () => {
  it("buckets a mostly-unpaved route as paths", () => {
    // 11=Dirt (unpaved), 3=Asphalt (paved)
    expect(characterFromSurface([{ value: 11, amount: 70 }, { value: 3, amount: 30 }])).toBe("mostlyPaths");
  });
  it("buckets a mixed route", () => {
    expect(characterFromSurface([{ value: 11, amount: 30 }, { value: 3, amount: 70 }])).toBe("mixed");
  });
  it("buckets a mostly-paved route as streets", () => {
    expect(characterFromSurface([{ value: 3, amount: 90 }, { value: 11, amount: 10 }])).toBe("mostlyStreets");
  });
  it("returns undefined when too little surface is tagged", () => {
    // 0=Unknown dominates; only 10% is classifiable.
    expect(characterFromSurface([{ value: 0, amount: 90 }, { value: 3, amount: 10 }])).toBeUndefined();
  });
  it("returns undefined without surface data", () => {
    expect(characterFromSurface(undefined)).toBeUndefined();
    expect(characterFromSurface(null)).toBeUndefined();
    expect(characterFromSurface("nope")).toBeUndefined();
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

describe("rankCandidates", () => {
  const mk = (km: number, overlapPct: number, elevation = 20): SuggestedRoute => ({
    id: "x", points: [], km, elevation, overlapPct,
  });

  it("ranks the closest, cleanest loop first and annotates length error", () => {
    const ranked = rankCandidates([mk(7, 0), mk(5, 0.05), mk(6, 0)], 5);
    expect(ranked[0].km).toBe(5);
    expect(ranked[0].lengthErrorPct).toBeCloseTo(0, 5);
  });

  it("never drops candidates — worst still shows", () => {
    expect(rankCandidates([mk(7, 0), mk(5, 0), mk(9, 0.8)], 5)).toHaveLength(3);
  });

  it("nudges toward the flattest loop when 'flat' is preferred (same length)", () => {
    // Two equal-length, equal-overlap loops: flat wins on the flat preference.
    const hilly = mk(5, 0, 150); // 30 m/km
    const flat = mk(5, 0, 10);   // 2 m/km
    const ranked = rankCandidates([hilly, flat], 5, "flat");
    expect(ranked[0].elevation).toBe(10);
  });

  it("nudges toward the hilliest loop when 'hilly' is preferred (same length)", () => {
    const hilly = mk(5, 0, 150);
    const flat = mk(5, 0, 10);
    const ranked = rankCandidates([flat, hilly], 5, "hilly");
    expect(ranked[0].elevation).toBe(150);
  });

  it("keeps length accuracy dominant over the elevation nudge", () => {
    // A dead-flat loop that's 40% too long must NOT beat an on-target hilly one
    // even under a 'flat' preference — the elevation term only nudges.
    const onTargetHilly = mk(5, 0, 150);
    const tooLongFlat = mk(7, 0, 0);
    const ranked = rankCandidates([tooLongFlat, onTargetHilly], 5, "flat");
    expect(ranked[0].km).toBe(5);
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

describe("historyNearCandidates", () => {
  const candidate = { points: [[45.75, 4.85, null], [45.76, 4.86, null]] as [number, number, number | null][] };
  it("keeps history points inside the candidates' padded bbox", () => {
    const inside: [number, number, number | null] = [45.755, 4.855, null];
    const far: [number, number, number | null] = [40, 2, null];
    const kept = historyNearCandidates([inside, far], [candidate]);
    expect(kept).toContainEqual(inside);
    expect(kept).not.toContainEqual(far);
  });
  it("returns [] with no candidates or no history", () => {
    expect(historyNearCandidates([[45.75, 4.85, null]], [])).toEqual([]);
    expect(historyNearCandidates([], [candidate])).toEqual([]);
  });
});

// The overlap scores are grid-indexed rather than full O(n^2) scans (a 20 km
// loop was tens of ms per candidate on the main thread). The index is only a
// pair-skipping optimisation, so the results must be IDENTICAL to the naive
// scan — these pin that against brute-force reimplementations on pseudo-random
// geometry, including the degenerate cases (dense clusters, exact duplicates).
function bruteSelfOverlap(points: [number, number, number | null][], thresholdM = 20): number {
  const n = points.length;
  if (n < 8) return 0;
  const nearStart = Math.max(2, Math.floor(n * 0.1));
  const nearEnd = n - nearStart;
  const overlapped = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i - 4; j++) {
      if (i >= nearEnd && j <= nearStart) continue;
      if (haversineM(points[i], points[j]) < thresholdM) { overlapped[i] = overlapped[j] = true; }
    }
  }
  return overlapped.filter(Boolean).length / n;
}

function bruteHistoryOverlap(
  points: [number, number, number | null][],
  history: [number, number, number | null][],
  thresholdM = 25,
): number {
  if (!points.length || !history.length) return 0;
  let near = 0;
  for (const p of points) {
    for (const h of history) {
      if (haversineM(p, h) < thresholdM) { near++; break; }
    }
  }
  return near / points.length;
}

// Deterministic pseudo-random generator so a failure is reproducible.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("overlap scoring: grid index matches a full scan", () => {
  it("agrees with brute force on random walks at several densities", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rng = makeRng(seed);
      // Spread controls how often points land within the threshold: a tight
      // walk overlaps constantly, a loose one almost never.
      const spread = 0.00005 + (seed % 4) * 0.0002;
      const pts: [number, number, number | null][] = [];
      let lat = 45.75, lng = 4.85;
      for (let i = 0; i < 160; i++) {
        lat += (rng() - 0.5) * spread;
        lng += (rng() - 0.5) * spread;
        pts.push([lat, lng, null]);
      }
      expect(selfOverlapPct(pts)).toBe(bruteSelfOverlap(pts));

      const hist: [number, number, number | null][] = [];
      let hlat = 45.75, hlng = 4.85;
      for (let i = 0; i < 120; i++) {
        hlat += (rng() - 0.5) * spread;
        hlng += (rng() - 0.5) * spread;
        hist.push([hlat, hlng, null]);
      }
      expect(overlapWithHistory(pts, hist)).toBe(bruteHistoryOverlap(pts, hist));
    }
  });

  it("agrees on exact duplicates and points sharing a cell boundary", () => {
    const p: [number, number, number | null] = [45.75, 4.85, null];
    const dup: [number, number, number | null][] = Array.from({ length: 20 }, () => [...p] as [number, number, number | null]);
    expect(selfOverlapPct(dup)).toBe(bruteSelfOverlap(dup));
    expect(overlapWithHistory(dup, dup)).toBe(bruteHistoryOverlap(dup, dup));
    // Straddle a grid line: floor(lat/dLat) differs by 1 but the metres don't.
    const straddle: [number, number, number | null][] = [];
    for (let i = 0; i < 40; i++) straddle.push([45.75 + (i % 2) * 0.00002, 4.85 + i * 0.000005, null]);
    expect(selfOverlapPct(straddle)).toBe(bruteSelfOverlap(straddle));
  });

  it("agrees in the southern/western hemisphere (negative coordinates floor differently)", () => {
    const rng = makeRng(99);
    const pts: [number, number, number | null][] = [];
    let lat = -33.87, lng = -70.66;
    for (let i = 0; i < 120; i++) {
      lat += (rng() - 0.5) * 0.0002;
      lng += (rng() - 0.5) * 0.0002;
      pts.push([lat, lng, null]);
    }
    expect(selfOverlapPct(pts)).toBe(bruteSelfOverlap(pts));
    expect(overlapWithHistory(pts, pts)).toBe(bruteHistoryOverlap(pts, pts));
  });
});
