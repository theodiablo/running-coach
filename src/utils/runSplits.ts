// Per-kilometre splits for RunDetailModal's split table. Derived from the SAME
// distance walk as distanceKm and buildRunSeries (flattenTrack), so the table,
// the chart and the run total agree on where each km lands. Pure and unit-tested.
//
// Time at each exact km mark is linearly interpolated along the track, so a
// split's duration isn't quantised to whole GPS fixes.

import { elevGainM, flattenTrack } from "./geo";
import type { FlatPoint, TrackPointOrGap } from "./geo";
import type { HrSample } from "./runSeries";

export type Split = {
  km: number;                  // 1-based split number
  distKm: number;              // length of this split (1.0, or the partial remainder)
  durationSec: number;
  paceSecPerKm: number;
  elevGainM: number;
  avgHr: number | null;
  fastest: boolean;            // among FULL kms only
  slowest: boolean;
};

export type SplitOpts = { jitterM?: number };

// Linear-interpolated time (epoch ms) at a given cumulative-km mark along `pts`.
function timeAtKm(pts: FlatPoint[], km: number): number {
  if (!pts.length) return 0;
  if (km <= pts[0].cumKm) return pts[0].t;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].cumKm >= km) {
      const a = pts[i - 1], b = pts[i];
      const span = b.cumKm - a.cumKm;
      if (span <= 0) return b.t; // frozen distance (jitter) — take the later time
      return a.t + ((km - a.cumKm) / span) * (b.t - a.t);
    }
  }
  return pts[pts.length - 1].t;
}

export function buildSplits(
  points: TrackPointOrGap[],
  hrSamples?: HrSample[] | null,
  opts?: SplitOpts,
): Split[] {
  const hr = hrSamples && hrSamples.length ? hrSamples : null;
  const pts = flattenTrack(points, opts?.jitterM ?? 3);
  const totalKm = pts.length ? pts[pts.length - 1].cumKm : 0;
  if (pts.length < 2 || totalKm <= 0) return [];

  // Mean bpm over [t0, t1]. `hr` is time-sorted, so binary-search the lower bound
  // and sweep forward — O(log n + window) per split, not O(n) (avoids a full scan
  // of a multi-hour ~1Hz stream per split).
  const avgHrBetween = (t0: number, t1: number): number | null => {
    if (!hr) return null;
    let lo = 0, hi = hr.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (hr[m].t < t0) lo = m + 1; else hi = m - 1; }
    let sum = 0, n = 0;
    for (let i = lo; i < hr.length && hr[i].t <= t1; i++) { sum += hr[i].bpm; n++; }
    return n ? Math.round(sum / n) : null;
  };

  const splits: Split[] = [];
  const nFull = Math.floor(totalKm);
  for (let k = 0; k < nFull || (k === nFull && totalKm - nFull > 0.001); k++) {
    const startKm = k;
    const endKm = Math.min(k + 1, totalKm);
    const tStart = timeAtKm(pts, startKm);
    const tEnd = timeAtKm(pts, endKm);
    const durationSec = (tEnd - tStart) / 1000;
    const distKm = endKm - startKm;
    const alts = pts.filter(pt => pt.cumKm >= startKm && pt.cumKm <= endKm).map(pt => ({ lat: 0, lng: 0, alt: pt.alt }));
    splits.push({
      km: k + 1,
      distKm,
      durationSec,
      paceSecPerKm: distKm > 0 ? durationSec / distKm : 0,
      elevGainM: Math.round(elevGainM(alts)),
      avgHr: avgHrBetween(tStart, tEnd),
      fastest: false,
      slowest: false,
    });
  }

  // Fastest / slowest among FULL kms only (a partial tail is never the winner).
  // Skip when they'd be the same split (all-equal pace) so one km is never marked
  // both fastest and slowest.
  const full = splits.filter(s => s.distKm >= 0.999);
  if (full.length >= 2) {
    let fast = full[0], slow = full[0];
    for (const s of full) {
      if (s.paceSecPerKm < fast.paceSecPerKm) fast = s;
      if (s.paceSecPerKm > slow.paceSecPerKm) slow = s;
    }
    if (fast !== slow) { fast.fastest = true; slow.slowest = true; }
  }
  return splits;
}
