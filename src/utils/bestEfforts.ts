// Best efforts: the fastest contiguous 1K / 5K / 10K / half / marathon inside a
// run, and where that run ranks against the rest of the log. Pure and
// unit-tested — no React, no network, no model call.
//
// This is the whole cost story for the feature: efforts are extracted ONCE, at
// save time, from the GPS trace the app already holds, and stored on the run as
// `bestEfforts`. Every later comparison is then an in-memory scan of `runs`, so
// ranking a run costs nothing and works offline. See docs/best-efforts.md.

import { flattenTrack } from "./geo";
import type { FlatPoint, TrackPointOrGap } from "./geo";
import type { Run } from "../types";

export type BestEffortKey = "1k" | "5k" | "10k" | "hm" | "fm";
export type BestEfforts = Partial<Record<BestEffortKey, number>>; // key → seconds

export const BEST_EFFORT_DISTANCES: { key: BestEffortKey; km: number }[] = [
  { key: "1k", km: 1 },
  { key: "5k", km: 5 },
  { key: "10k", km: 10 },
  { key: "hm", km: 21.0975 },
  { key: "fm", km: 42.195 },
];

// Ranks worth celebrating after a run. Copy pairs 1:1 with this ceiling
// (bestEfforts.badge.rank2 / .rank3), so raising it needs new strings.
export const ACHIEVEMENT_MAX_RANK = 3;

// How much longer than a standard distance a *traceless* run may be and still
// count as an effort at it (5% — a 10.4 km log is a 10K, a 12 km one isn't).
const WHOLE_RUN_TOL = 1.05;

// Fastest window of exactly `km` inside ONE gap-free segment, in seconds, or
// null when the segment is too short.
//
// Two-pointer sweep: the window ends on a real fix `j` and its start is
// interpolated along the leg it falls in, so the covered distance is exactly
// `km` rather than quantised to whole fixes. Only the start is interpolated —
// pinning the end to a sample can overshoot the true optimum by at most one leg
// (~2s at the tracker's sample rate), which errs SLOW. That direction matters:
// a best effort must never be reported faster than what was actually run.
function fastestWindowSec(seg: FlatPoint[], km: number): number | null {
  const n = seg.length;
  if (n < 2 || seg[n - 1].cumKm - seg[0].cumKm < km) return null;
  let best = Infinity, i = 0;
  for (let j = 1; j < n; j++) {
    while (i + 1 < j && seg[j].cumKm - seg[i + 1].cumKm >= km) i++;
    if (seg[j].cumKm - seg[i].cumKm < km) continue;
    const target = seg[j].cumKm - km; // where the window starts: between i and i+1
    const a = seg[i], b = seg[i + 1];
    const span = b.cumKm - a.cumKm;
    const tStart = span > 0 ? a.t + ((target - a.cumKm) / span) * (b.t - a.t) : b.t;
    const sec = (seg[j].t - tStart) / 1000;
    if (sec > 0 && sec < best) best = sec;
  }
  return best < Infinity ? best : null;
}

// Every standard distance the trace covers, fastest-first-window per distance.
// Windows never span a GAP marker: cumKm deliberately doesn't accrue across one
// (flattenTrack won't invent a straight jump) while wall-clock time does, so a
// window crossing a gap would price real distance against dead time.
export function bestEffortsFromTrack(
  points: TrackPointOrGap[],
  opts?: { jitterM?: number },
): BestEfforts {
  const segs: FlatPoint[][] = [];
  for (const p of flattenTrack(points, opts?.jitterM ?? 3)) {
    if (p.segStart || !segs.length) segs.push([]);
    segs[segs.length - 1].push(p);
  }
  const out: BestEfforts = {};
  for (const { key, km } of BEST_EFFORT_DISTANCES) {
    let best = Infinity;
    for (const seg of segs) {
      const sec = fastestWindowSec(seg, km);
      if (sec != null && sec < best) best = sec;
    }
    if (best < Infinity) out[key] = Math.round(best);
  }
  return out;
}

// A run with no trace (manual entry, watch import without GPS) still counts as
// an effort at the ONE standard distance it essentially *is*: its time scaled to
// the exact distance. Deliberately NOT applied to longer runs — average pace
// over a 12 km easy run is not a 10K effort, and inventing one would let a slow
// long run masquerade as a race performance.
export function wholeRunEfforts(run: Partial<Run> | null | undefined): BestEfforts {
  const km = Number(run?.km) || 0;
  const sec = Number(run?.durationSec) || 0;
  if (km <= 0 || sec <= 0) return {};
  for (const { key, km: d } of BEST_EFFORT_DISTANCES) {
    if (km >= d && km <= d * WHOLE_RUN_TOL) return { [key]: Math.round((sec * d) / km) };
  }
  return {};
}

// What a run's efforts ARE, for every reader. Measured values win; a run with
// none (never measured, or measured and covering no standard distance) falls
// back to the whole-run estimate, so pre-feature history still ranks.
export function effortsFor(run: Partial<Run> | null | undefined): BestEfforts {
  const stored = run?.bestEfforts;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const out: BestEfforts = {};
    for (const { key } of BEST_EFFORT_DISTANCES) {
      const v = Number((stored as Record<string, unknown>)[key]);
      if (Number.isFinite(v) && v > 0) out[key] = Math.round(v);
    }
    if (Object.keys(out).length) return out;
  }
  return wholeRunEfforts(run);
}

// True when this run's efforts are measured from its trace rather than estimated
// from its average pace — lets a surface footnote the difference honestly.
export function hasMeasuredEfforts(run: Partial<Run> | null | undefined): boolean {
  const stored = run?.bestEfforts;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return false;
  return BEST_EFFORT_DISTANCES.some(({ key }) => Number((stored as Record<string, unknown>)[key]) > 0);
}

export type EffortRank = {
  key: BestEffortKey;
  km: number;
  sec: number;
  rank: number;                                        // 1 = fastest in the log
  total: number;                                       // comparable runs, this one included
  previousBest: { sec: number; date: string } | null;  // best among the OTHERS
  gainSec: number | null;                              // seconds faster than previousBest
};

// Rank one run's efforts against the rest of the log. `allRuns` may include the
// run itself — it's excluded by id (falling back to identity for an unsaved one)
// so a run never outranks itself.
export function rankRunEfforts(run: Run, allRuns: Run[] = []): EffortRank[] {
  const mine = effortsFor(run);
  const distances = BEST_EFFORT_DISTANCES.filter(d => mine[d.key] != null);
  if (!distances.length) return [];
  const others = allRuns.filter(r => r && (run.id ? r.id !== run.id : r !== run));
  const rivals = others.map(r => ({ date: r.date, efforts: effortsFor(r) }));

  return distances.map(({ key, km }) => {
    const sec = mine[key] as number;
    let rank = 1, total = 1, previousBest: { sec: number; date: string } | null = null;
    for (const rival of rivals) {
      const rs = rival.efforts[key];
      if (rs == null) continue;
      total++;
      if (rs < sec) rank++;
      if (!previousBest || rs < previousBest.sec) previousBest = { sec: rs, date: rival.date };
    }
    return { key, km, sec, rank, total, previousBest, gainSec: previousBest ? previousBest.sec - sec : null };
  });
}

// A tie ranks equal-best (only strictly faster runs push you down), so a repeat
// of your exact PB time is a personal best with gainSec 0 rather than a demotion.
export const isPersonalBest = (e: EffortRank) => e.rank === 1 && e.total > 1;
export const isFirstEffort = (e: EffortRank) => e.total === 1;

// The subset of a run's efforts worth putting in front of the user, best rank
// first then longest distance. Empty means "nothing to celebrate" — the caller
// shows nothing at all rather than a consolation sheet.
//
// A runner-up rank must actually have beaten something: "3rd fastest" out of
// exactly three runs is last place wearing a rosette, and a new user would get
// one of those after every early run. Rank 1 always counts (a first effort is
// worth marking even with nothing to compare against).
export function runAchievements(run: Run, allRuns: Run[] = []): EffortRank[] {
  return rankRunEfforts(run, allRuns)
    .filter(e => e.rank <= ACHIEVEMENT_MAX_RANK && (e.rank === 1 || e.rank < e.total))
    .sort((a, b) => a.rank - b.rank || b.km - a.km);
}
