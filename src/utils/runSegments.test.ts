import { describe, it, expect } from "vitest";
import { runWalkBreakdown } from "./runSegments";
import type { TrackPointOrGap } from "./geo";

const T0 = Date.UTC(2026, 8, 20, 8, 0, 0);
const M_PER_DEG_LAT = 111_320;

// Synthesize a due-north trace at a given speed schedule, one fix every FIX_SEC
// seconds (what a stored trace looks like after simplify() thins it — legs have
// to clear flattenTrack's 3 m jitter floor to count at all). Pace is sec/km, so
// each fix steps the latitude by FIX_SEC * (1000 / pace) metres.
const FIX_SEC = 5;

function trace(schedule: { paceSecPerKm: number; sec: number }[], startSec = 0): TrackPointOrGap[] {
  const pts: TrackPointOrGap[] = [];
  let lat = 45, t = T0 + startSec * 1000;
  pts.push([lat, 6, t, 100]);
  for (const leg of schedule) {
    for (let i = 0; i < leg.sec / FIX_SEC; i++) {
      lat += (FIX_SEC * 1000 / leg.paceSecPerKm) / M_PER_DEG_LAT;
      t += FIX_SEC * 1000;
      pts.push([lat, 6, t, 100]);
    }
  }
  return pts;
}

// 6 × (2 min at 6:00/km + 1 min at 12:00/km) — a Galloway session.
const RUN_WALK = trace(Array.from({ length: 6 }, () => [
  { paceSecPerKm: 360, sec: 120 },
  { paceSecPerKm: 720, sec: 60 },
]).flat());

describe("runWalkBreakdown", () => {
  it("separates the running from the walk breaks", () => {
    const b = runWalkBreakdown(RUN_WALK)!;
    expect(b).not.toBeNull();
    // 12 min of running at 6:00 = 2 km; 6 min of walking at 12:00 = 0.5 km.
    expect(b.run.durationSec).toBeCloseTo(720, -1);
    expect(b.walk.durationSec).toBeCloseTo(360, -1);
    expect(b.run.paceSecPerKm).toBeGreaterThan(330);
    expect(b.run.paceSecPerKm).toBeLessThan(390);
    expect(b.walk.paceSecPerKm).toBeGreaterThan(660);
    expect(b.run.bouts).toBe(6);
    expect(b.walk.bouts).toBe(6);
    expect(b.cutSecPerKm).toBeGreaterThan(400);
    expect(b.cutSecPerKm).toBeLessThan(680);
  });

  // The running-only pace is the whole point: the whole-run average (2.5 km in
  // 18 min = 7:12/km) describes neither half of the session.
  it("reports a running pace well clear of the whole-run average", () => {
    const b = runWalkBreakdown(RUN_WALK)!;
    const wholeRun = 1080 / 2.5;
    expect(b.run.paceSecPerKm).toBeLessThan(wholeRun - 45);
  });

  it("says nothing about a steady run", () => {
    // Small honest variation around 5:30/km — one mode, no split to report.
    const steady = trace(Array.from({ length: 20 }, (_, i) => (
      { paceSecPerKm: 330 + (i % 4) * 8, sec: 60 }
    )));
    expect(runWalkBreakdown(steady)).toBeNull();
  });

  it("says nothing about a run with a single stop in it", () => {
    // One 40 s walk for a road crossing is not an alternation.
    const oneStop = trace([
      { paceSecPerKm: 330, sec: 600 },
      { paceSecPerKm: 900, sec: 40 },
      { paceSecPerKm: 330, sec: 600 },
    ]);
    expect(runWalkBreakdown(oneStop)).toBeNull();
  });

  it("says nothing about a walk, where the faster mode is still walking", () => {
    const walk = trace(Array.from({ length: 8 }, () => [
      { paceSecPerKm: 780, sec: 120 },
      { paceSecPerKm: 1020, sec: 60 },
    ]).flat());
    expect(runWalkBreakdown(walk)).toBeNull();
  });

  it("says nothing about a run too short to read", () => {
    const brief = trace([
      { paceSecPerKm: 330, sec: 60 },
      { paceSecPerKm: 780, sec: 30 },
      { paceSecPerKm: 330, sec: 60 },
    ]);
    expect(runWalkBreakdown(brief)).toBeNull();
  });

  it("never bridges a GPS gap, and ignores the pause across it", () => {
    const a = trace(Array.from({ length: 4 }, () => [
      { paceSecPerKm: 360, sec: 120 },
      { paceSecPerKm: 720, sec: 60 },
    ]).flat());
    // Resumes 20 minutes later, a kilometre away: bridging that leg would read
    // as an hour-per-km "walk" and swamp the walk cluster.
    const b = trace(Array.from({ length: 4 }, () => [
      { paceSecPerKm: 360, sec: 120 },
      { paceSecPerKm: 720, sec: 60 },
    ]).flat(), 1920).map(p => p && [Number(p[0]) + 0.01, p[1], p[2], p[3]] as TrackPointOrGap);
    const split = runWalkBreakdown([...a, null, ...b])!;
    expect(split).not.toBeNull();
    expect(split.walk.paceSecPerKm).toBeLessThan(900);
    expect(split.run.bouts).toBe(8);
  });

  it("attributes heart rate to the half it was measured in", () => {
    const samples = [];
    // 150 bpm while running, 120 while walking, one sample a second.
    for (let cycle = 0; cycle < 6; cycle++) {
      const base = T0 + cycle * 180_000;
      for (let i = 0; i < 120; i++) samples.push({ bpm: 150, t: base + i * 1000 });
      for (let i = 120; i < 180; i++) samples.push({ bpm: 120, t: base + i * 1000 });
    }
    const b = runWalkBreakdown(RUN_WALK, samples)!;
    expect(b.run.avgHr).toBeGreaterThan(b.walk.avgHr!);
    expect(b.run.avgHr).toBeGreaterThan(145);
    expect(b.walk.avgHr).toBeLessThan(130);
  });

  it("has nothing to say without a trace", () => {
    expect(runWalkBreakdown([])).toBeNull();
    expect(runWalkBreakdown([[45, 6, T0, 100]])).toBeNull();
  });
});
