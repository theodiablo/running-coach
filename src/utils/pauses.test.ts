import { describe, it, expect } from "vitest";
import { closePauses, pausedMsBefore, readPauses, recoveredPauses, samplesPausesRemoved, tracePausesRemoved } from "./pauses";
import { buildSplits } from "./runSplits";
import { buildRunSeries } from "./runSeries";
import { distanceKm } from "./geo";
import type { TrackPointOrGap } from "./geo";

const T0 = 1_700_000_000_000;
const S = (sec: number) => T0 + sec * 1000;
// ~0.111 km per 0.001° of longitude at the equator.
const STEP = 0.001, STEP_KM = 0.11132;

// A steady 6:00/km run, one fix per step; `pauseAfter` inserts a pause of `pauseSec`
// after that fix (the tracker drops fixes while paused, so none land inside it).
function steadyRun(steps: number, pauseAfter: number | null, pauseSec: number) {
  const pts: TrackPointOrGap[] = [];
  const legSec = STEP_KM * 360;
  let t = 0, pause: [number, number] | null = null;
  for (let i = 0; i <= steps; i++) {
    pts.push([0, i * STEP, S(t), null]);
    t += legSec;
    if (i === pauseAfter) { pause = [S(t - legSec / 2), S(t - legSec / 2 + pauseSec)]; t += pauseSec; }
  }
  return { pts, pauses: pause ? [pause] : [] };
}

describe("readPauses", () => {
  it("keeps closed, well-formed windows in time order and drops the rest", () => {
    expect(readPauses([[5, 9], [1, 2], [3, 3], [4, null], "x", [7]])).toEqual([[1, 2], [5, 9]]);
    expect(readPauses(undefined)).toEqual([]);
  });

  it("merges overlapping and nested windows so the moving clock never runs backwards", () => {
    const pauses = readPauses([[0, 10], [5, 15], [6, 8], [20, 30]]);
    expect(pauses).toEqual([[0, 15], [20, 30]]);
    const moving = [0, 5, 7, 10, 12, 15, 20, 25, 40].map(t => t - pausedMsBefore(pauses, t));
    for (let i = 1; i < moving.length; i++) expect(moving[i]).toBeGreaterThanOrEqual(moving[i - 1]);
  });
});

describe("pausedMsBefore", () => {
  it("counts whole pauses before t and the elapsed part of one containing it", () => {
    const pauses = [[100, 200], [300, 400]] as const;
    expect(pausedMsBefore(pauses, 50)).toBe(0);
    expect(pausedMsBefore(pauses, 150)).toBe(50);
    expect(pausedMsBefore(pauses, 250)).toBe(100);
    expect(pausedMsBefore(pauses, 1000)).toBe(200);
  });
});

describe("tracePausesRemoved", () => {
  it("is the identity with no pauses", () => {
    const { pts } = steadyRun(10, null, 0);
    expect(tracePausesRemoved(pts, [])).toBe(pts);
  });

  it("shifts later fixes back by the paused time and cuts the track at the pause", () => {
    const { pts, pauses } = steadyRun(10, 4, 180);
    const out = tracePausesRemoved(pts, pauses);
    expect(out[5]).toBeNull();
    const before = out[4] as number[], after = out[6] as number[];
    expect(after[2] - before[2]).toBeCloseTo(STEP_KM * 360 * 1000, -1);
    expect(distanceKm(out)).toBeCloseTo(distanceKm(pts), 9);
  });

  it("does not stack a second marker on a pause that already left a gap", () => {
    const { pts, pauses } = steadyRun(10, 4, 180);
    const gapped = [...pts.slice(0, 5), null, ...pts.slice(5)];
    expect(tracePausesRemoved(gapped, pauses).filter(p => p == null)).toHaveLength(1);
  });
});

describe("splits and pace on the moving clock", () => {
  // The reported run: a 3-minute pause in km 2 of a steady 6:00/km run.
  const { pts, pauses } = steadyRun(27, 13, 180);

  it("a pause no longer slows the km it fell in", () => {
    expect(Math.round(buildSplits(pts)[1].paceSecPerKm)).toBe(540);
    const splits = buildSplits(tracePausesRemoved(pts, pauses));
    for (const s of splits.filter(x => x.distKm > 0.999)) expect(s.paceSecPerKm).toBeCloseTo(360, -1);
  });

  it("the pace chart has no spike after a short pause that left no gap marker", () => {
    const short = steadyRun(27, 13, 45);
    const peak = (p: TrackPointOrGap[]) => Math.max(...buildRunSeries(p).map(r => r.paceSecPerKm ?? 0));
    expect(peak(short.pts)).toBeGreaterThan(500);
    expect(peak(tracePausesRemoved(short.pts, short.pauses))).toBeCloseTo(360, -1);
  });

  it("heart-rate samples move with the trace", () => {
    const [[a, b]] = pauses;
    const out = samplesPausesRemoved([{ bpm: 150, t: a - 1000 }, { bpm: 151, t: b + 1000 }], pauses);
    expect(out[1].t - out[0].t).toBe(2000);
  });
});

describe("recording helpers", () => {
  it("closePauses closes only the open window", () => {
    expect(closePauses([[1, 2], [5, null]], 9)).toEqual([[1, 2], [5, 9]]);
  });

  it("a recovered run is off the clock from where it stopped until Resume", () => {
    expect(recoveredPauses([[1, 2]], 50)).toEqual([[1, 2], [50, null]]);
    expect(recoveredPauses([[1, 2], [40, null]], 50)).toEqual([[1, 2], [40, null]]);
    expect(recoveredPauses("junk", 50)).toEqual([[50, null]]);
  });
});
