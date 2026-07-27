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
// count as an effort at it (5% — a 10.4 km log is a 10K, a 12 km one isn't),
// and how much shorter (1%). The short side is not symmetry for its own sake: a
// half is routinely logged as "21" and a marathon as "42" (some race catalogue
// editions store them that way too), and a one-sided window silently gave those
// no effort at all. Scaling a slightly-short run UP to the distance lengthens
// its time, so the tolerance can't manufacture a fast one.
const WHOLE_RUN_TOL_LONG = 1.05;
const WHOLE_RUN_TOL_SHORT = 0.99;

// Distances are a claim about *running*. A walk or a cross-training entry with a
// distance on it would otherwise be measured and celebrated ("first 5K on the
// board" for a family walk) and, worse, counted in `total`, loosening the
// `rank < total` guard that stops a last place wearing a rosette. Read-time, so
// re-typing a run fixes it retroactively either way.
const NON_RUNNING_TYPES = new Set(["WALK", "OTHER"]);
const countsAsRunning = (run: Partial<Run> | null | undefined) =>
  !NON_RUNNING_TYPES.has(String(run?.type ?? "").toUpperCase());

// A leg covered faster than this wasn't run. No import path emits gap markers
// (`fit.ts`, `gpx.ts`, `imports/series.ts` all produce unbroken arrays), so a
// stretch travelled with the watch paused — or a GPS fix that teleported —
// arrives as one ordinary leg and would be priced as running. 10 m/s is 1:40/km,
// well beyond the 1000 m world record, so nothing genuine trips it. `dt` is
// floored at 1 s because import timestamps are often whole-second, which would
// otherwise make every same-second leg look infinitely fast.
const MAX_LEG_SPEED_MS = 10;

// Fastest window of exactly `km` inside ONE gap-free segment, in seconds, or
// null when the segment is too short.
//
// Two-pointer sweep: the window ends on a real fix `j` and its start is
// interpolated along the leg it falls in, so the covered distance is exactly
// `km` rather than quantised to whole fixes. Pinning the end to a sample errs
// SLOW. The interpolated start assumes an even pace across its leg, so it can
// land a second or two either side of the truth — traces are stored SIMPLIFIED
// (5 m Douglas-Peucker), so a straight stretch collapses into one long leg and
// the "one sample" intuition doesn't hold. Grossly wrong legs never reach here:
// `trackSegments` cuts the track at anything faster than a human runs.
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

// The gap-free, plausibly-run stretches of a track. A window may only be
// measured inside one of these.
//
// Two things break a segment. A GAP marker: cumKm deliberately doesn't accrue
// across one (flattenTrack won't invent a straight jump) while wall-clock time
// does, so a window crossing a gap would price real distance against dead time.
// And an impossibly fast leg, which is the same problem wearing a disguise —
// a drive with the watch paused leaves no marker in an imported file, and
// interpolating across it yields a 30-second kilometre that then poisons every
// later ranking. Cutting there drops the travelled distance from every window.
function trackSegments(points: TrackPointOrGap[], jitterM: number): FlatPoint[][] {
  const segs: FlatPoint[][] = [];
  let prev: FlatPoint | null = null;
  for (const p of flattenTrack(points, jitterM)) {
    const legM = prev ? (p.cumKm - prev.cumKm) * 1000 : 0;
    const legSec = prev ? (p.t - prev.t) / 1000 : 0;
    const teleport = !!prev && legM / Math.max(legSec, 1) > MAX_LEG_SPEED_MS;
    if (p.segStart || teleport || !segs.length) segs.push([]);
    segs[segs.length - 1].push(p);
    prev = p;
  }
  return segs;
}

// Every standard distance the trace covers, fastest window per distance.
export function bestEffortsFromTrack(
  points: TrackPointOrGap[],
  opts?: { jitterM?: number },
): BestEfforts {
  const segs = trackSegments(points, opts?.jitterM ?? 3);
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
    if (km >= d * WHOLE_RUN_TOL_SHORT && km <= d * WHOLE_RUN_TOL_LONG) {
      return { [key]: Math.round((sec * d) / km) };
    }
  }
  return {};
}

// What the trace actually yielded for this run, junk dropped. Absent or `{}`
// both mean "no measurement for that distance".
export function measuredEfforts(run: Partial<Run> | null | undefined): BestEfforts {
  const stored = run?.bestEfforts;
  const out: BestEfforts = {};
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return out;
  for (const { key } of BEST_EFFORT_DISTANCES) {
    const v = Number((stored as Record<string, unknown>)[key]);
    if (Number.isFinite(v) && v > 0) out[key] = Math.round(v);
  }
  return out;
}

// What a run's efforts ARE, for every reader. Measured values win, and the
// whole-run estimate fills the gaps PER DISTANCE rather than per run: a GPS 5K
// measures a few tens of metres short once jitter gating and 5 m simplification
// have had their way, so it stores `{1k}` and an all-or-nothing fallback left it
// with no 5K at all — permanently, since the stored map also keeps the backfill
// away — while the same run typed in by hand ranked fine.
export function effortsFor(run: Partial<Run> | null | undefined): BestEfforts {
  if (!countsAsRunning(run)) return {};
  const out = measuredEfforts(run);
  const est = wholeRunEfforts(run);
  for (const { key } of BEST_EFFORT_DISTANCES) {
    if (out[key] == null && est[key] != null) out[key] = est[key];
  }
  return out;
}

export type EffortRank = {
  key: BestEffortKey;
  km: number;
  sec: number;
  rank: number;                                        // 1 = fastest in the log
  total: number;                                       // comparable runs, this one included
  previousBest: { sec: number; date: string } | null;  // best among the OTHERS
  gainSec: number | null;                              // seconds faster than previousBest
  estimated: boolean;                                  // scaled from average pace, not measured
};

// Rank one run's efforts against the rest of the log. `allRuns` may include the
// run itself — it's excluded by id (falling back to identity for an unsaved one)
// so a run never outranks itself.
export function rankRunEfforts(run: Run, allRuns: Run[] = []): EffortRank[] {
  const mine = effortsFor(run);
  const distances = BEST_EFFORT_DISTANCES.filter(d => mine[d.key] != null);
  if (!distances.length) return [];
  // Per distance, not per run: with the gap-filling fallback a single run can
  // carry a measured 1K next to an estimated 5K, and a surface has to be able to
  // footnote exactly the ones it's estimating.
  const measured = measuredEfforts(run);
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
    return { key, km, sec, rank, total, previousBest,
      gainSec: previousBest ? previousBest.sec - sec : null, estimated: measured[key] == null };
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
