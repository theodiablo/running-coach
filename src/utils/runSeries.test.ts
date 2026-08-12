import { describe, it, expect } from "vitest";
import { buildRunSeries } from "./runSeries";
import { distanceKm } from "./geo";
import type { TrackPointOrGap } from "./geo";

// A stored point tuple [lat, lng, tEpochMs, alt]. Timestamps in whole seconds
// from a base so they're easy to reason about.
const T0 = 1_700_000_000_000;
const p = (lat: number, lng: number, sec: number, alt: number | null = null): TrackPointOrGap =>
  [lat, lng, T0 + sec * 1000, alt];

describe("buildRunSeries", () => {
  it("emits one row per real point and skips gap markers", () => {
    const rows = buildRunSeries([p(0, 0, 0), null, p(0, 0.01, 10)]);
    expect(rows).toHaveLength(2);
  });

  it("cumulative distance is monotonic and matches distanceKm", () => {
    const pts = [p(0, 0, 0), p(0, 0.01, 20), p(0, 0.02, 40), p(0, 0.03, 60)];
    const rows = buildRunSeries(pts);
    for (let i = 1; i < rows.length; i++) expect(rows[i].distKm).toBeGreaterThanOrEqual(rows[i - 1].distKm);
    expect(rows[rows.length - 1].distKm).toBeCloseTo(distanceKm(pts), 5);
  });

  it("does not bridge a gap on the x-axis (distance frozen across the gap)", () => {
    // Two points, then a gap, then a far-away point: the gap leg must NOT add
    // distance, unlike distanceKm's summary bridging.
    const rows = buildRunSeries([p(0, 0, 0), p(0, 0.01, 20), null, p(0, 5, 40), p(0, 5.01, 60)]);
    // Row index 2 is the first point after the gap; its distKm equals row 1's
    // (no jump added for the gap leg), then it grows again.
    expect(rows[2].distKm).toBeCloseTo(rows[1].distKm, 5);
    expect(rows[3].distKm).toBeGreaterThan(rows[2].distKm);
  });

  it("does not compute pace across a gap", () => {
    const rows = buildRunSeries([p(0, 0, 0), p(0, 0.01, 20), null, p(0, 5, 40), p(0, 5.01, 60)]);
    // First point after the gap resets the segment → no look-back → null pace.
    expect(rows[2].paceSecPerKm).toBeNull();
    expect(rows[3].paceSecPerKm).not.toBeNull();
  });

  it("returns null pace for a single point", () => {
    const rows = buildRunSeries([p(0, 0, 0)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].paceSecPerKm).toBeNull();
    expect(rows[0].distKm).toBe(0);
  });

  it("computes a plausible pace over consecutive points", () => {
    // ~1.11 km between longitudes 0 and 0.01 at the equator, over 300 s ⇒ ~270 s/km.
    const rows = buildRunSeries([p(0, 0, 0), p(0, 0.01, 300)]);
    expect(rows[1].paceSecPerKm).toBeGreaterThan(200);
    expect(rows[1].paceSecPerKm).toBeLessThan(340);
  });

  it("computes pace even when points are sparse in time (simplified track)", () => {
    // Points ~30 s apart — far wider than any fixed time window. A distance-window
    // smoother must still produce a continuous pace (no null gaps mid-segment).
    const pts = [p(0, 0, 0), p(0, 0.005, 90), p(0, 0.01, 180), p(0, 0.015, 270)];
    const rows = buildRunSeries(pts);
    expect(rows[0].paceSecPerKm).toBeNull();          // segment start
    expect(rows.slice(1).every(r => r.paceSecPerKm != null)).toBe(true);
  });

  it("carries elevation and nulls missing altitude", () => {
    const rows = buildRunSeries([p(0, 0, 0, 100), p(0, 0.01, 20, null), p(0, 0.02, 40, 130)]);
    expect(rows[0].elevM).toBe(100);
    expect(rows[1].elevM).toBeNull();
    expect(rows[2].elevM).toBe(130);
  });

  it("has all null HR when no samples are given", () => {
    const rows = buildRunSeries([p(0, 0, 0), p(0, 0.01, 20)]);
    expect(rows.every(r => r.hr === null)).toBe(true);
  });

  it("keeps a continuous HR line across sparsely stored points", () => {
    // The regression this guards: simplify() leaves points ~30s apart, so a
    // fixed ±4s match nulled almost every row and a real HR stream rendered as
    // a few isolated dots. Each point averages its own slice instead.
    const pts = [p(0, 0, 0), p(0, 0.01, 30), p(0, 0.02, 60), p(0, 0.03, 90)];
    const samples = Array.from({ length: 180 }, (_, i) => ({ bpm: 150, t: T0 + i * 500 }));
    const rows = buildRunSeries(pts, samples);
    expect(rows.every(r => r.hr === 150)).toBe(true);
  });

  it("averages the samples inside a point's slice", () => {
    const pts = [p(0, 0, 0), p(0, 0.01, 20), p(0, 0.02, 40)];
    // Slice around the middle point is [10s, 30s]: 140 and 160 average to 150.
    const samples = [
      { bpm: 100, t: T0 + 0 },
      { bpm: 140, t: T0 + 15000 },
      { bpm: 160, t: T0 + 25000 },
      { bpm: 200, t: T0 + 40000 },
    ];
    expect(buildRunSeries(pts, samples)[1].hr).toBe(150);
  });

  it("still nulls HR where the stream actually has a hole", () => {
    // Dense points, HR only over the first 10s: the later rows must stay null
    // rather than borrowing a reading from minutes earlier.
    const pts = Array.from({ length: 20 }, (_, i) => p(0, i * 0.001, i * 10));
    const samples = Array.from({ length: 20 }, (_, i) => ({ bpm: 150, t: T0 + i * 500 }));
    const rows = buildRunSeries(pts, samples);
    expect(rows[0].hr).toBe(150);
    expect(rows[rows.length - 1].hr).toBeNull();
  });

  it("does not pull HR across a gap into the next segment", () => {
    const pts = [p(0, 0, 0), p(0, 0.01, 10), null, p(0, 5, 20), p(0, 5.01, 30)];
    const samples = [{ bpm: 150, t: T0 + 10000 }];
    const rows = buildRunSeries(pts, samples, { hrWindowMs: 1000 });
    expect(rows[1].hr).toBe(150);  // last point of the first segment
    expect(rows[2].hr).toBeNull(); // first point after the gap must not reach back
  });

  it("aligns HR to the sample nearest a point when slices hold one each", () => {
    const samples = [
      { bpm: 120, t: T0 + 1000 },
      { bpm: 140, t: T0 + 19000 },
      { bpm: 160, t: T0 + 41000 },
    ];
    const rows = buildRunSeries([p(0, 0, 0), p(0, 0.01, 20), p(0, 0.02, 40)], samples, { hrWindowMs: 4000 });
    expect(rows[0].hr).toBe(120); // point t=0s, nearest sample at +1s
    expect(rows[1].hr).toBe(140); // point t=20s, nearest sample at +19s
    expect(rows[2].hr).toBe(160); // point t=40s, nearest sample at +41s
  });

  it("nulls HR when the nearest sample is outside the window", () => {
    const samples = [{ bpm: 120, t: T0 + 0 }];
    const rows = buildRunSeries([p(0, 0, 0), p(0, 0.01, 60)], samples, { hrWindowMs: 4000 });
    expect(rows[0].hr).toBe(120);   // exactly on the sample
    expect(rows[1].hr).toBeNull();  // 60 s away, outside ±4 s
  });
});
