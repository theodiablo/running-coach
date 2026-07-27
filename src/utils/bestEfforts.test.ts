import { describe, it, expect } from "vitest";
import {
  bestEffortsFromTrack,
  wholeRunEfforts,
  effortsFor,
  measuredEfforts,
  rankRunEfforts,
  runAchievements,
  isPersonalBest,
  isFirstEffort,
  BEST_EFFORT_DISTANCES,
} from "./bestEfforts";
import type { TrackPointOrGap } from "./geo";
import type { Run } from "../types";

// A straight eastward track at a fixed pace. One point per `stepM` metres, with
// per-leg pace overridable so a fast stretch can be planted mid-run.
// 0.001 degrees of longitude at the equator ≈ 111.32 m.
const M_PER_DEG = 111320;
function track(legs: { meters: number; paceSecPerKm: number }[], t0 = 1_700_000_000_000): TrackPointOrGap[] {
  const pts: TrackPointOrGap[] = [[0, 0, t0, 0]];
  let lng = 0, t = t0;
  for (const leg of legs) {
    const steps = Math.round(leg.meters / 10);
    for (let i = 0; i < steps; i++) {
      lng += 10 / M_PER_DEG;
      t += (10 / 1000) * leg.paceSecPerKm * 1000;
      pts.push([0, lng, Math.round(t), 0]);
    }
  }
  return pts;
}

const flat = (meters: number, paceSecPerKm: number) => track([{ meters, paceSecPerKm }]);

describe("bestEffortsFromTrack", () => {
  it("finds an effort for every standard distance the trace covers", () => {
    const efforts = bestEffortsFromTrack(flat(6000, 300));
    expect(Object.keys(efforts).sort()).toEqual(["1k", "5k"]);
    expect(efforts["1k"]).toBeCloseTo(300, -1);
    expect(efforts["5k"]).toBeCloseTo(1500, -1);
  });

  it("returns nothing for a trace shorter than the smallest distance", () => {
    expect(bestEffortsFromTrack(flat(800, 300))).toEqual({});
  });

  it("returns nothing for an empty or single-point trace", () => {
    expect(bestEffortsFromTrack([])).toEqual({});
    expect(bestEffortsFromTrack([[0, 0, 1_700_000_000_000, 0]])).toEqual({});
  });

  it("picks the fastest window, not the first or the average", () => {
    // 2 km easy, 1 km hard, 3 km easy — the best 1K is the hard one.
    const efforts = bestEffortsFromTrack(track([
      { meters: 2000, paceSecPerKm: 360 },
      { meters: 1000, paceSecPerKm: 240 },
      { meters: 3000, paceSecPerKm: 360 },
    ]));
    expect(efforts["1k"]).toBeCloseTo(240, -1);
    // The whole run averages 340 s/km, so a 5K read off average pace would be
    // 1700 s; the real fastest 5K window straddles the surge and is quicker.
    expect(efforts["5k"]!).toBeLessThan(1700);
  });

  it("does not report an even-paced window faster than the ground truth", () => {
    // At a constant pace the start interpolation is exact, so all that is left is
    // the end pinned to a real fix — which can only overshoot.
    const efforts = bestEffortsFromTrack(flat(5200, 300));
    expect(efforts["5k"]!).toBeGreaterThanOrEqual(1500);
    expect(efforts["5k"]!).toBeLessThan(1500 + 10);
  });

  it("does not build a window across a gap marker", () => {
    // Two 3 km halves either side of an hour-long GPS blackout. A 5K window can
    // only exist by spanning the gap, so there must be none.
    const first = flat(3000, 300);
    const second = flat(3000, 300).map(p => p && [p[0], (p[1] as number) + 1, (p[2] as number) + 3_600_000, p[3]] as TrackPointOrGap);
    const efforts = bestEffortsFromTrack([...first, null, ...second]);
    expect(efforts["1k"]).toBeCloseTo(300, -1);
    expect(efforts["5k"]).toBeUndefined();
  });

  it("finds the fastest window in the second segment after a gap", () => {
    const slow = flat(2000, 400);
    const fast = flat(2000, 240).map(p => p && [p[0], (p[1] as number) + 1, (p[2] as number) + 600_000, p[3]] as TrackPointOrGap);
    const efforts = bestEffortsFromTrack([...slow, null, ...fast]);
    expect(efforts["1k"]).toBeCloseTo(240, -1);
  });

  it("is not fooled by a stationary stretch inside a segment", () => {
    // 1.5 km run, then 100 fixes going nowhere over ~3 min, then 1.5 km run —
    // a sub-GAP_MS breather, so the tracker leaves no gap marker. Jitter gating
    // means the standstill adds time but no distance, so the best 1K is still a
    // genuine running kilometre rather than one padded with standing around.
    const t0 = 1_700_000_000_000;
    const first = flat(1500, 300);
    const lastLng = first[first.length - 1]![1] as number;
    const lastT = first[first.length - 1]![2] as number;
    const still: TrackPointOrGap[] = Array.from({ length: 100 }, (_, i) =>
      [0, lastLng, lastT + (i + 1) * 2000, 0] as TrackPointOrGap);
    const resumeT = lastT + 200_000;
    const second = flat(1500, 300).map(p => p && [p[0], (p[1] as number) + lastLng, (p[2] as number) - t0 + resumeT, p[3]] as TrackPointOrGap);
    const efforts = bestEffortsFromTrack([...first, ...still, ...second]);
    expect(efforts["1k"]).toBeCloseTo(300, -1);
  });

  it("does not run a window through a stretch that was travelled, not run", () => {
    // The shape an import produces: a 1.2 km jog, the watch paused for a 20 km
    // drive over 10 min, then another 1.2 km jog. No import path emits gap
    // markers, so this arrives as one unbroken array and the drive is just a very
    // long leg. Interpolating across it used to yield a 30-second kilometre.
    const t0 = 1_700_000_000_000;
    const first = flat(1200, 300);
    const lastLng = first[first.length - 1]![1] as number;
    const lastT = first[first.length - 1]![2] as number;
    const resumeLng = lastLng + 20_000 / M_PER_DEG, resumeT = lastT + 600_000;
    const second = flat(1200, 300).map(p => p &&
      [0, (p[1] as number) + resumeLng, (p[2] as number) - t0 + resumeT, p[3]] as TrackPointOrGap);
    const efforts = bestEffortsFromTrack([...first, ...second]);
    expect(efforts["1k"]).toBeCloseTo(300, -1);
    expect(efforts["5k"]).toBeUndefined();
    expect(efforts["10k"]).toBeUndefined();
    expect(efforts["hm"]).toBeUndefined();
  });

  it("drops a teleporting GPS fix rather than measuring the jump", () => {
    // One bad fix 500 m off-course and back, mid-run. The 500 m it invents would
    // otherwise land inside a 1K window as free distance.
    const pts = flat(3000, 300);
    const spike = pts[150]!;
    pts[150] = [0, (spike[1] as number) + 500 / M_PER_DEG, spike[2], spike[3]] as TrackPointOrGap;
    expect(bestEffortsFromTrack(pts)["1k"]).toBeCloseTo(300, -1);
  });

  it("tolerates whole-second import timestamps without cutting the track up", () => {
    // GPX timestamps are commonly 1 s resolution, so fixes 4 m apart at 4:00/km
    // land on the same second. A raw distance/dt reads those legs as infinitely
    // fast and would shred a perfectly good trace into unmeasurable slivers.
    const t0 = 1_700_000_000_000;
    const pts: TrackPointOrGap[] = [];
    for (let i = 0; i <= 500; i++) {
      pts.push([0, (i * 4) / M_PER_DEG, t0 + Math.floor(i * 0.96) * 1000, 0]);
    }
    expect(pts.some((p, i) => i > 0 && p![2] === pts[i - 1]![2])).toBe(true);
    expect(bestEffortsFromTrack(pts)["1k"]).toBeCloseTo(240, -1);
  });
});

describe("wholeRunEfforts", () => {
  it("credits a run that essentially IS a standard distance", () => {
    expect(wholeRunEfforts({ km: 5, durationSec: 1500 })).toEqual({ "5k": 1500 });
  });

  it("scales a slightly-long run down to the exact distance", () => {
    // 10.4 km in 52:00 (300 s/km) → a 10K at 50:00.
    expect(wholeRunEfforts({ km: 10.4, durationSec: 3120 })).toEqual({ "10k": 3000 });
  });

  it("credits nothing to a run comfortably longer than the distance", () => {
    expect(wholeRunEfforts({ km: 12, durationSec: 3600 })).toEqual({});
    expect(wholeRunEfforts({ km: 8, durationSec: 2400 })).toEqual({});
  });

  it("credits nothing without a distance or a duration", () => {
    expect(wholeRunEfforts({ km: 5 })).toEqual({});
    expect(wholeRunEfforts({ km: 0, durationSec: 1500 })).toEqual({});
    expect(wholeRunEfforts(null)).toEqual({});
  });

  it("handles the half and the marathon at their true distances", () => {
    expect(wholeRunEfforts({ km: 21.1, durationSec: 6330 })["hm"]).toBe(6329);
    expect(wholeRunEfforts({ km: 42.2, durationSec: 12660 })["fm"]).toBe(12658);
  });

  it("credits a half logged as a round 21 km, and a marathon as 42", () => {
    // The common way people (and some catalogue editions) record them. Scaling a
    // slightly-short run UP lengthens its time, so the tolerance can't invent a
    // fast one.
    expect(wholeRunEfforts({ km: 21, durationSec: 6300 })["hm"]).toBe(6329);
    expect(wholeRunEfforts({ km: 42, durationSec: 12600 })["fm"]).toBe(12659);
  });

  it("still credits nothing to a run meaningfully short of the distance", () => {
    expect(wholeRunEfforts({ km: 4.5, durationSec: 1350 })).toEqual({});
    expect(wholeRunEfforts({ km: 9.5, durationSec: 2850 })).toEqual({});
  });
});

describe("effortsFor", () => {
  it("prefers measured efforts over the whole-run estimate", () => {
    const run: Run = { date: "2026-07-01", km: 5.02, durationSec: 1600, bestEfforts: { "5k": 1400 } };
    expect(effortsFor(run)).toEqual({ "5k": 1400 });
  });

  it("falls back to the estimate when a run was never measured", () => {
    expect(effortsFor({ date: "2026-07-01", km: 5, durationSec: 1500 })).toEqual({ "5k": 1500 });
  });

  it("falls back when a measured run stored an empty result", () => {
    // A 5.02 km GPS run whose jitter-gated trace measured 4.98 km stores {} —
    // the estimate is the better answer, not "no 5K".
    const run: Run = { date: "2026-07-01", km: 5.02, durationSec: 1500, bestEfforts: {} };
    expect(effortsFor(run)["5k"]).toBe(1494);
  });

  it("ignores junk values in a stored blob", () => {
    const run = { date: "2026-07-01", km: 12, durationSec: 3600,
      bestEfforts: { "5k": 0, "10k": -3, "1k": Number.NaN, hm: 5000 } } as unknown as Run;
    expect(effortsFor(run)).toEqual({ hm: 5000 });
  });

  it("fills a distance the trace missed without discarding the measured ones", () => {
    // A GPS 5K: the stored trace is jitter-gated and 5 m-simplified, so its
    // cumulative distance lands just under 5 km and only a 1K window exists.
    // All-or-nothing fallback left this run with no 5K at all — for good, since
    // a non-empty stored map also keeps the backfill away — while the very same
    // run typed in by hand ranked fine.
    const run: Run = { date: "2026-07-01", km: 5.014, durationSec: 1500, bestEfforts: { "1k": 292 } };
    expect(effortsFor(run)).toEqual({ "1k": 292, "5k": 1496 });
  });

  it("gives a walk or a cross-training entry no efforts at all", () => {
    // "First 5K on the board" for a family walk is a false claim, and counting
    // one inflates `total`, loosening the rank < total guard.
    expect(effortsFor({ type: "WALK", km: 5, durationSec: 3000 })).toEqual({});
    expect(effortsFor({ type: "OTHER", km: 5, durationSec: 1500, bestEfforts: { "5k": 1400 } })).toEqual({});
    expect(effortsFor({ type: "EASY", km: 5, durationSec: 1500 })).toEqual({ "5k": 1500 });
    expect(effortsFor({ km: 5, durationSec: 1500 })).toEqual({ "5k": 1500 });
  });
});

describe("measuredEfforts", () => {
  it("reports only what the trace yielded", () => {
    expect(measuredEfforts({ km: 5, durationSec: 1500, bestEfforts: { "5k": 1490 } })).toEqual({ "5k": 1490 });
    expect(measuredEfforts({ km: 5, durationSec: 1500 })).toEqual({});
    expect(measuredEfforts({ km: 5, durationSec: 1500, bestEfforts: {} })).toEqual({});
  });
});

const run = (id: string, date: string, efforts: Record<string, number>): Run =>
  ({ id, date, km: 5, durationSec: efforts["5k"] || 1500, bestEfforts: efforts });

describe("rankRunEfforts", () => {
  it("ranks a run against the rest of the log and never against itself", () => {
    const target = run("c", "2026-07-20", { "5k": 1400 });
    const all = [target, run("a", "2026-05-01", { "5k": 1500 }), run("b", "2026-06-01", { "5k": 1450 })];
    const [e] = rankRunEfforts(target, all);
    expect(e).toMatchObject({ key: "5k", sec: 1400, rank: 1, total: 3, gainSec: 50 });
    expect(e.previousBest).toEqual({ sec: 1450, date: "2026-06-01" });
  });

  it("reports a mid-table rank with the standing best", () => {
    const target = run("c", "2026-07-20", { "5k": 1480 });
    const all = [target, run("a", "2026-05-01", { "5k": 1400 }), run("b", "2026-06-01", { "5k": 1450 })];
    const [e] = rankRunEfforts(target, all);
    expect(e).toMatchObject({ rank: 3, total: 3, gainSec: -80 });
    expect(e.previousBest).toEqual({ sec: 1400, date: "2026-05-01" });
  });

  it("treats a first-ever effort as rank 1 of 1 with no previous best", () => {
    const target = run("a", "2026-07-20", { "5k": 1500 });
    const [e] = rankRunEfforts(target, [target]);
    expect(e).toMatchObject({ rank: 1, total: 1, previousBest: null, gainSec: null });
    expect(isFirstEffort(e)).toBe(true);
    expect(isPersonalBest(e)).toBe(false);
  });

  it("ranks a tie as equal-best rather than demoting it", () => {
    const target = run("b", "2026-07-20", { "5k": 1400 });
    const [e] = rankRunEfforts(target, [target, run("a", "2026-05-01", { "5k": 1400 })]);
    expect(e).toMatchObject({ rank: 1, total: 2, gainSec: 0 });
    expect(isPersonalBest(e)).toBe(true);
  });

  it("only compares like distances", () => {
    const target: Run = { id: "b", date: "2026-07-20", km: 10, durationSec: 3000, bestEfforts: { "1k": 260, "5k": 1400, "10k": 3000 } };
    const ranks = rankRunEfforts(target, [target, run("a", "2026-05-01", { "5k": 1300 })]);
    expect(ranks.map(r => [r.key, r.rank, r.total])).toEqual([["1k", 1, 1], ["5k", 2, 2], ["10k", 1, 1]]);
  });

  it("returns nothing for a run with no efforts at all", () => {
    expect(rankRunEfforts({ id: "a", date: "2026-07-20", km: 0.4, durationSec: 120 }, [])).toEqual([]);
  });

  it("flags each effort as measured or estimated, not the run as a whole", () => {
    // The mixed case the per-distance fallback creates: a measured 1K next to a
    // 5K the trace fell short of. The detail card footnotes off this.
    const target: Run = { id: "b", date: "2026-07-20", km: 5.014, durationSec: 1500, bestEfforts: { "1k": 292 } };
    const ranks = rankRunEfforts(target, [target]);
    expect(ranks.map(r => [r.key, r.estimated])).toEqual([["1k", false], ["5k", true]]);
  });

  it("does not let a walk into the comparison pool", () => {
    const target = run("b", "2026-07-20", { "5k": 1500 });
    const walk: Run = { id: "w", date: "2026-05-01", type: "WALK", km: 5, durationSec: 3000 };
    const [e] = rankRunEfforts(target, [target, walk]);
    expect(e).toMatchObject({ rank: 1, total: 1, previousBest: null });
  });

  it("compares measured runs against estimated history", () => {
    const target: Run = { id: "b", date: "2026-07-20", km: 8, durationSec: 2400, bestEfforts: { "5k": 1450, "1k": 270 } };
    const manual: Run = { id: "a", date: "2026-05-01", km: 5, durationSec: 1500 };
    const ranks = rankRunEfforts(target, [target, manual]);
    expect(ranks.find(r => r.key === "5k")).toMatchObject({ rank: 1, total: 2, gainSec: 50 });
  });
});

describe("runAchievements", () => {
  const slower = (n: number) => Array.from({ length: n }, (_, i) =>
    run("old" + i, "2026-0" + ((i % 5) + 1) + "-01", { "5k": 1500 + i }));

  it("surfaces a personal best first", () => {
    const target: Run = { id: "new", date: "2026-07-20", km: 10, durationSec: 3000, bestEfforts: { "1k": 280, "5k": 1400, "10k": 3000 } };
    const wins = runAchievements(target, [target, ...slower(4)]);
    expect(wins[0]).toMatchObject({ key: "10k", rank: 1 });
    expect(wins.map(w => w.key)).toEqual(["10k", "5k", "1k"]);
  });

  it("drops anything outside the top three", () => {
    const target = run("new", "2026-07-20", { "5k": 1600 });
    expect(runAchievements(target, [target, ...slower(5).map((r, i) => run("f" + i, r.date, { "5k": 1400 + i }))])).toEqual([]);
  });

  it("keeps a second- or third-fastest result that actually beat something", () => {
    const target = run("new", "2026-07-20", { "5k": 1450 });
    const wins = runAchievements(target, [target, run("a", "2026-01-01", { "5k": 1400 }), run("b", "2026-02-01", { "5k": 1500 })]);
    expect(wins).toHaveLength(1);
    expect(wins[0]).toMatchObject({ rank: 2, total: 3 });
  });

  it("does not dress up last place as a ranking", () => {
    // 2nd of 2 and 3rd of 3 are both "slowest so far" — without this a new user
    // would get a rosette after every one of their first few runs.
    const secondOfTwo = run("new", "2026-07-20", { "5k": 1500 });
    expect(runAchievements(secondOfTwo, [secondOfTwo, run("a", "2026-01-01", { "5k": 1400 })])).toEqual([]);
    const thirdOfThree = run("new2", "2026-07-20", { "5k": 1600 });
    expect(runAchievements(thirdOfThree, [thirdOfThree,
      run("a", "2026-01-01", { "5k": 1400 }), run("b", "2026-02-01", { "5k": 1500 })])).toEqual([]);
  });

  it("still celebrates a personal best set against a single rival", () => {
    const target = run("new", "2026-07-20", { "5k": 1300 });
    const wins = runAchievements(target, [target, run("a", "2026-01-01", { "5k": 1400 })]);
    expect(wins).toHaveLength(1);
    expect(isPersonalBest(wins[0])).toBe(true);
  });

  it("celebrates a first run", () => {
    const target = run("new", "2026-07-20", { "5k": 1700 });
    const wins = runAchievements(target, [target]);
    expect(wins).toHaveLength(1);
    expect(isFirstEffort(wins[0])).toBe(true);
  });
});

describe("BEST_EFFORT_DISTANCES", () => {
  it("is ordered shortest-first so wholeRunEfforts matches the tightest distance", () => {
    const kms = BEST_EFFORT_DISTANCES.map(d => d.km);
    expect([...kms].sort((a, b) => a - b)).toEqual(kms);
  });
});
