import { describe, it, expect } from "vitest";
import { buildSplits } from "./runSplits";
import { distanceKm } from "./geo";
import type { TrackPointOrGap } from "./geo";

const T0 = 1_700_000_000_000;
const p = (lat: number, lng: number, sec: number, alt: number | null = null): TrackPointOrGap =>
  [lat, lng, T0 + sec * 1000, alt];

// A degree of longitude at the equator is ~111.32 km, so lng 0 → 0.02 is ~2.23 km.
// Build a straight equator run of `nPoints` evenly spaced over `totalSec`.
function equatorRun(endLng: number, nPoints: number, totalSec: number, alts?: (i: number) => number | null): TrackPointOrGap[] {
  const out: TrackPointOrGap[] = [];
  for (let i = 0; i < nPoints; i++) {
    const f = i / (nPoints - 1);
    out.push(p(0, endLng * f, totalSec * f, alts ? alts(i) : null));
  }
  return out;
}

describe("buildSplits", () => {
  it("returns a full split per km plus a partial remainder", () => {
    // ~2.23 km run → 2 full kms + a partial third.
    const splits = buildSplits(equatorRun(0.02, 60, 600));
    expect(splits.length).toBe(3);
    expect(splits[0].km).toBe(1);
    expect(splits[0].distKm).toBeCloseTo(1, 2);
    expect(splits[1].distKm).toBeCloseTo(1, 2);
    expect(splits[2].distKm).toBeLessThan(1);      // partial tail
    expect(splits[2].distKm).toBeGreaterThan(0);
  });

  it("splits add up to distanceKm when the track has a GPS gap", () => {
    // Signal lost for ~0.45 km mid-run: the gap still counts toward the km marks.
    const run = equatorRun(0.02, 60, 600);
    const gapped = [...run.slice(0, 20), null, ...run.slice(32)];
    const splits = buildSplits(gapped);
    const sum = splits.reduce((a, s) => a + s.distKm, 0);
    expect(sum).toBeCloseTo(distanceKm(gapped), 6);
    expect(sum).toBeCloseTo(distanceKm(run), 6);
  });

  it("computes a plausible pace per split", () => {
    // Even pace: ~2.23 km over 600 s ⇒ ~269 s/km on each full split.
    const splits = buildSplits(equatorRun(0.02, 60, 600));
    for (const s of splits.filter(x => x.distKm >= 0.999)) {
      expect(s.paceSecPerKm).toBeGreaterThan(250);
      expect(s.paceSecPerKm).toBeLessThan(290);
    }
  });

  it("flags fastest and slowest among full kms only", () => {
    // First km slow (400 s), second km fast (200 s): front-load time so km1 is slower.
    const pts: TrackPointOrGap[] = [
      p(0, 0, 0),
      p(0, 0.009, 400),   // ~1.00 km at 400 s
      p(0, 0.018, 600),   // ~2.00 km at 600 s (this km took 200 s)
      p(0, 0.02, 660),    // partial tail
    ];
    const splits = buildSplits(pts);
    const km1 = splits.find(s => s.km === 1)!;
    const km2 = splits.find(s => s.km === 2)!;
    expect(km1.slowest).toBe(true);
    expect(km2.fastest).toBe(true);
    // The partial tail is never marked.
    const tail = splits.find(s => s.distKm < 0.999);
    expect(tail?.fastest).toBe(false);
    expect(tail?.slowest).toBe(false);
  });

  it("averages HR within each split's time window", () => {
    const samples = [
      { bpm: 130, t: T0 + 100_000 },   // within km1 (0..~269s)
      { bpm: 150, t: T0 + 200_000 },   // within km1
      { bpm: 170, t: T0 + 400_000 },   // within km2
    ];
    const splits = buildSplits(equatorRun(0.02, 60, 600), samples);
    expect(splits[0].avgHr).toBe(140); // (130+150)/2
    expect(splits[1].avgHr).toBe(170);
  });

  it("returns null avgHr when no HR samples", () => {
    const splits = buildSplits(equatorRun(0.02, 60, 600));
    expect(splits.every(s => s.avgHr === null)).toBe(true);
  });

  it("captures elevation gain per split", () => {
    // Climb 0→200 m linearly across the run; each km should show a chunk of gain.
    const splits = buildSplits(equatorRun(0.02, 60, 600, i => Math.round((i / 59) * 200)));
    expect(splits[0].elevGainM).toBeGreaterThan(0);
    const total = splits.reduce((s, x) => s + x.elevGainM, 0);
    expect(total).toBeGreaterThan(150); // most of the 200 m climb, minus hysteresis
  });

  it("returns a single partial split for a sub-1km run", () => {
    const splits = buildSplits(equatorRun(0.005, 20, 200)); // ~0.56 km
    expect(splits.length).toBe(1);
    expect(splits[0].distKm).toBeLessThan(1);
    expect(splits[0].fastest).toBe(false); // <2 full kms → no flags
  });

  it("returns [] for an empty or single-point track", () => {
    expect(buildSplits([])).toEqual([]);
    expect(buildSplits([p(0, 0, 0)])).toEqual([]);
  });
});
