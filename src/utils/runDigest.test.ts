// Parity + shape tests for the coach agent's run-detail digest module
// (supabase/functions/_shared/coach/runDigest.mjs). That file PORTS the pure
// helpers in src/utils/{geo,runSeries,runSplits,hr}.ts to dependency-free ESM
// so the Deno edge function can use them; these tests pin the ports to the TS
// originals on shared fixtures so the two can't silently drift, and pin the
// digest's two hard guarantees: compact (~2KB) and coordinate-free.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain ESM module shared with the Supabase edge function.
import * as digest from "../../supabase/functions/_shared/coach/runDigest.mjs";
import { flattenTrack, elevGainM, distanceKm } from "./geo";
import type { TrackPointOrGap } from "./geo";
import { buildRunSeries } from "./runSeries";
import { compactHrSamples, expandHrSamples } from "./hr";
import { buildSplits } from "./runSplits";
import { timeInZones, effectiveMaxHR } from "./hr";

const T0 = 1_700_000_000_000;
const p = (lat: number, lng: number, sec: number, alt: number | null = null): TrackPointOrGap =>
  [lat, lng, T0 + sec * 1000, alt];

// A synthetic ~3.3km track: steady eastward progress with altitude, a GPS gap,
// then a final segment. ~0.111 km per 0.001° of longitude at the equator.
const track: TrackPointOrGap[] = [];
for (let i = 0; i <= 20; i++) track.push(p(0, i * 0.001, i * 30, 100 + i * 2));
track.push(null); // signal drop
for (let i = 0; i <= 8; i++) track.push(p(0, 0.025 + i * 0.001, 700 + i * 30, 140 - i));

// A ~1Hz-ish HR stream over the same window, trending up.
const hrStream = Array.from({ length: 200 }, (_, i) => ({ bpm: 120 + Math.round(i / 8), t: T0 + i * 5000 }));

const SETTINGS = { maxHR: 190, restHR: 55 };

describe("runDigest.mjs parity with the TS originals", () => {
  it("flattenTrack: same cumulative distances and timestamps, no coordinates", () => {
    const ours = digest.flattenTrack(track);
    const ref = flattenTrack(track);
    expect(ours).toHaveLength(ref.length);
    ours.forEach((f: Record<string, unknown>, i: number) => {
      expect(f.cumKm).toBeCloseTo(ref[i].cumKm, 9);
      expect(f.t).toBe(ref[i].t);
      expect(f.alt).toBe(ref[i].alt);
      expect(f.segStart).toBe(ref[i].segStart);
      expect(f).not.toHaveProperty("lat");
      expect(f).not.toHaveProperty("lng");
    });
  });

  it("expandHrSamples parity on a compacted stream", () => {
    const stored = compactHrSamples(hrStream);
    expect(digest.expandHrSamples(stored)).toEqual(expandHrSamples(stored));
  });

  it("haversineM parity via total distance", () => {
    const flat = digest.flattenTrack(track);
    expect(flat[flat.length - 1].cumKm).toBeGreaterThan(0);
    expect(flat[flat.length - 1].cumKm).toBeCloseTo(distanceKm(track), 6);
  });

  it("elevGainM parity (hysteresis band, null altitudes, gap resets)", () => {
    const withNulls: TrackPointOrGap[] = [p(0, 0, 0, 100), p(0, 0.001, 30, null), null, p(0, 0.002, 60, 112), p(0, 0.003, 90, 105), p(0, 0.004, 120, 120)];
    expect(digest.elevGainM(digest.flattenTrack(withNulls))).toBe(elevGainM(withNulls));
    expect(digest.elevGainM(digest.flattenTrack(track))).toBe(elevGainM(track));
  });

  it("elevGainM parity with altitude glitches (altitudeGate)", () => {
    const glitchy: TrackPointOrGap[] = [p(0, 0, 0, 300), p(0, 0.001, 2, 150), p(0, 0.002, 4, 150), null, p(0, 0.003, 6, 300), p(0, 0.004, 8, 320)];
    expect(digest.elevGainM(digest.flattenTrack(glitchy))).toBe(elevGainM(glitchy));
    expect(elevGainM(glitchy)).toBe(0);
  });

  it("series rows match buildRunSeries (distance, pace, elevation, HR alignment)", () => {
    const ours = digest.buildSeriesRows(track, hrStream);
    const ref = buildRunSeries(track, hrStream);
    expect(ours).toHaveLength(ref.length);
    ours.forEach((r: Record<string, number | null>, i: number) => {
      expect(r.distKm).toBeCloseTo(ref[i].distKm, 9);
      expect(r.tSec).toBe(ref[i].tSec);
      expect(r.elevM).toBe(ref[i].elevM);
      if (ref[i].paceSecPerKm == null) expect(r.paceSecPerKm).toBeNull();
      else expect(r.paceSecPerKm).toBeCloseTo(ref[i].paceSecPerKm as number, 6);
      expect(r.hr).toBe(ref[i].hr);
    });
  });

  it("split rows match buildSplits (minus the fastest/slowest flags)", () => {
    const ours = digest.buildSplitRows(track, hrStream);
    const ref = buildSplits(track, hrStream);
    expect(ours).toHaveLength(ref.length);
    ours.forEach((s: Record<string, number | null>, i: number) => {
      expect(s.km).toBe(ref[i].km);
      expect(s.distKm).toBeCloseTo(ref[i].distKm, 9);
      expect(s.durationSec).toBeCloseTo(ref[i].durationSec, 6);
      expect(s.paceSecPerKm).toBeCloseTo(ref[i].paceSecPerKm, 6);
      expect(s.elevGainM).toBe(ref[i].elevGainM);
      expect(s.avgHr).toBe(ref[i].avgHr);
      expect(s).not.toHaveProperty("fastest");
    });
  });

  it("timeInZones and effectiveMaxHR parity", () => {
    expect(digest.timeInZones(hrStream, 190, 55)).toEqual(timeInZones(hrStream, 190, 55));
    expect(digest.timeInZones(hrStream, 0, 55)).toEqual(timeInZones(hrStream, 0, 55));
    const today = new Date("2026-07-18T00:00:00");
    expect(digest.effectiveMaxHR({ maxHR: 190 }, today)).toBe(effectiveMaxHR({ maxHR: 190 }, today));
    expect(digest.effectiveMaxHR({ birthYear: 1990 }, today)).toBe(effectiveMaxHR({ birthYear: 1990 }, today));
    expect(digest.effectiveMaxHR({ age: 40 }, today)).toBe(effectiveMaxHR({ age: 40 }, today));
    expect(digest.effectiveMaxHR({}, today)).toBe(effectiveMaxHR({}, today));
  });
});

// Recursively assert no lat/lng-named keys anywhere in the digest.
function assertNoCoordinates(value: unknown, path = "digest"): void {
  if (Array.isArray(value)) { value.forEach((v, i) => assertNoCoordinates(v, `${path}[${i}]`)); return; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      expect(["lat", "lng", "latitude", "longitude", "points"], `coordinate-ish key at ${path}`).not.toContain(k);
      assertNoCoordinates(v, `${path}.${k}`);
    }
  }
}

const RUN = { id: "r1", date: "2026-07-20", type: "LONG", km: 3.2, durationSec: 940, hr: 132, hrMax: 151, effort: 3 };

describe("buildRunDigest", () => {
  it("full GPS+HR run: splits, zones, series, elevation — compact and coordinate-free", () => {
    const d = digest.buildRunDigest({ run: RUN, points: track, stats: { hrSamples: hrStream }, settings: SETTINGS });
    expect(d.runId).toBe("r1");
    expect(d.splits.length).toBeGreaterThan(2);
    expect(d.hrZones.length).toBe(5);
    expect(d.hrZones.reduce((a: number, z: { pctTime: number }) => a + z.pctTime, 0)).toBeGreaterThan(95);
    expect(d.series.length).toBeGreaterThan(5);
    expect(d.series.length).toBeLessThanOrEqual(50);
    expect(d.elevGainM).toBeGreaterThan(0);
    assertNoCoordinates(d);
  });

  it("stays under ~2.5KB even for a marathon-scale run with a dense HR stream", () => {
    const bigTrack: TrackPointOrGap[] = [];
    for (let i = 0; i <= 4200; i++) bigTrack.push(p(0, i * 0.0001, i * 4, 100 + Math.sin(i / 100) * 40));
    const bigHr = Array.from({ length: 16800 }, (_, i) => ({ bpm: 130 + Math.round(10 * Math.sin(i / 500)), t: T0 + i * 1000 }));
    const d = digest.buildRunDigest({
      run: { ...RUN, km: 42.2, durationSec: 16800 },
      points: bigTrack, stats: { hrSamples: bigHr }, settings: SETTINGS,
    });
    expect(JSON.stringify(d).length).toBeLessThan(4000);
    expect(d.splits.length).toBeLessThanOrEqual(45);
    expect(d.series.length).toBeLessThanOrEqual(50);
    assertNoCoordinates(d);
  });

  it("ultra-length run: splits truncate to 45 WITH an explanatory note", () => {
    // ~55 km: 0.0001° lng ≈ 11.1 m per step at the equator.
    const ultra: TrackPointOrGap[] = [];
    for (let i = 0; i <= 5000; i++) ultra.push(p(0, i * 0.0001, i * 5, 100));
    const d = digest.buildRunDigest({ run: { ...RUN, km: 55 }, points: ultra, stats: {}, settings: SETTINGS });
    expect(d.splits.length).toBe(45);
    expect(d.notes.join(" ")).toMatch(/truncated to the first 45/);
  });

  it("maxHR set but unusable reserve: zone note does NOT claim max HR is missing", () => {
    const d = digest.buildRunDigest({
      run: RUN, points: track, stats: { hrSamples: hrStream },
      settings: { maxHR: 60, restHR: 80 }, // restHR >= maxHR → reserve <= 0
    });
    expect(d.hrZones).toBeUndefined();
    expect(d.notes.join(" ")).not.toMatch(/not set a max heart rate/);
    expect(d.notes.join(" ")).toMatch(/HR zones unavailable/);
  });

  it("HR-only route (no GPS): time-indexed HR series + zones, with a note", () => {
    const d = digest.buildRunDigest({ run: RUN, points: [], stats: { hrSamples: hrStream }, settings: SETTINGS });
    expect(d.splits).toBeUndefined();
    expect(d.hrZones.length).toBe(5);
    expect(d.series.every((r: Record<string, number>) => typeof r.t === "number" && typeof r.h === "number")).toBe(true);
    expect(d.notes.join(" ")).toMatch(/GPS was not recorded/);
    assertNoCoordinates(d);
  });

  it("no maxHR: zones omitted with an explanatory note", () => {
    const d = digest.buildRunDigest({ run: RUN, points: track, stats: { hrSamples: hrStream }, settings: {} });
    expect(d.hrZones).toBeUndefined();
    expect(d.notes.join(" ")).toMatch(/max heart rate/);
  });

  it("no HR stream: GPS analytics only, with a note", () => {
    const d = digest.buildRunDigest({ run: RUN, points: track, stats: {}, settings: SETTINGS });
    expect(d.hrZones).toBeUndefined();
    expect(d.splits.length).toBeGreaterThan(0);
    expect(d.notes.join(" ")).toMatch(/no heart-rate data/);
  });

  it("nothing recorded: header + note only, never a throw", () => {
    const d = digest.buildRunDigest({ run: RUN, points: [], stats: {}, settings: SETTINGS });
    expect(d.series).toBeUndefined();
    expect(d.splits).toBeUndefined();
    expect(d.notes.join(" ")).toMatch(/no detailed data/);
  });

  it("track without altitude: no elevGainM, altitude note present", () => {
    const flatTrack = [p(0, 0, 0), p(0, 0.005, 90), p(0, 0.01, 180)];
    const d = digest.buildRunDigest({ run: RUN, points: flatTrack, stats: {}, settings: SETTINGS });
    expect(d.elevGainM).toBeUndefined();
    expect(d.notes.join(" ")).toMatch(/altitude/);
  });
});
