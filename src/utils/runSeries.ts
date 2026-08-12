// Per-run analytics series: turn a stored GPS trace (+ optional raw HR stream)
// into recharts-ready rows for RunDetailModal's combined chart. Pure and
// unit-tested — no React/SDK imports.
//
// A point is the stored tuple [lat, lng, tEpochMs, altMeters|null]; a `null`
// entry is a GAP marker (lost GPS). We emit one row per REAL point and use gaps
// only to break continuity (pace never bridges a gap; the x-axis never invents a
// straight jump across one). HR is aligned to each point by timestamp at render,
// so HR fidelity is decoupled from how aggressively simplify() thinned the track.
//
// Each row averages the samples inside the point's OWN time slice (halfway to
// each neighbour). A fixed ±4s window used to null the HR on any point that
// happened to fall between samples, and stored points are ~20-30s apart after
// simplification — so a run with real but intermittent HR rendered as a handful
// of isolated dots rather than the line it measured. A slice with no samples in
// it still yields null: a hole in the stream stays a hole.

import { flattenTrack } from "./geo";
import type { TrackPointOrGap } from "./geo";

export type HrSample = { bpm: number; t: number };

export type RunSeriesRow = {
  distKm: number;               // cumulative distance from the start
  tSec: number;                 // seconds since the first fix (optional time x-axis)
  elevM: number | null;         // point altitude (null when the phone reported none)
  paceSecPerKm: number | null;  // smoothed, gap-aware; null across gaps / too-short window
  hr: number | null;            // nearest raw HR sample; null when absent/out of window
};

export type RunSeriesOpts = {
  paceWindowM?: number;   // rolling DISTANCE look-back (m) for pace smoothing
  jitterM?: number;       // legs shorter than this are treated as GPS jitter
  hrWindowMs?: number;    // MINIMUM half-width of a point's HR slice
  hrSliceMaxMs?: number;  // and its cap, so a long GPS gap can't drag HR in from far away
};

// Mean bpm of the samples in [from, to], or null when the window is empty.
// `samples` is assumed sorted ascending by `t` (they're appended in order live);
// binary-searches the first sample at or after `from` and walks forward.
function avgBpmIn(samples: HrSample[], from: number, to: number): number | null {
  let lo = 0, hi = samples.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < from) lo = mid + 1;
    else hi = mid - 1;
  }
  let sum = 0, n = 0;
  for (let i = lo; i < samples.length && samples[i].t <= to; i++) { sum += samples[i].bpm; n++; }
  return n ? Math.round(sum / n) : null;
}

export function buildRunSeries(
  points: TrackPointOrGap[],
  hrSamples?: HrSample[] | null,
  opts?: RunSeriesOpts,
): RunSeriesRow[] {
  const paceWindowM = opts?.paceWindowM ?? 200;
  const jitterM = opts?.jitterM ?? 3;
  const hrWindowMs = opts?.hrWindowMs ?? 4000;
  const hrSliceMaxMs = opts?.hrSliceMaxMs ?? 30000;
  const hr = hrSamples && hrSamples.length ? hrSamples : null;

  const flat = flattenTrack(points, jitterM);
  if (!flat.length) return [];
  const t0 = flat[0].t;

  const rows: RunSeriesRow[] = [];
  let segStartIdx = 0;
  for (let i = 0; i < flat.length; i++) {
    const f = flat[i];
    if (f.segStart) segStartIdx = i;

    // Smoothed pace over a rolling DISTANCE window (not a fixed time window):
    // stored points are Douglas-Peucker-thinned, so they're sparse and uneven in
    // time — a short time window finds no earlier point on straight, sparsely
    // sampled stretches and would leave pace null there (an intermittent line).
    // Look back over ~paceWindowM metres within the segment, but always include at
    // least the previous point so every point past a segment's start gets a pace.
    let pace: number | null = null;
    if (i > segStartIdx) {
      let w = i - 1;
      while (w > segStartIdx && (f.cumKm - flat[w - 1].cumKm) * 1000 <= paceWindowM) w--;
      const dt = (f.t - flat[w].t) / 1000;
      const dkm = f.cumKm - flat[w].cumKm;
      if (dt > 0 && dkm > 0) pace = dt / dkm;
    }

    // The point's own slice: halfway to each neighbour, never across a gap
    // (the next segment's HR isn't this point's), floored so dense points still
    // catch a sample and capped so a sparse stretch stays local.
    let hrBpm: number | null = null;
    if (hr) {
      const prev = i > segStartIdx ? flat[i - 1] : null;
      const next = i + 1 < flat.length && !flat[i + 1].segStart ? flat[i + 1] : null;
      const back = Math.max(hrWindowMs, Math.min(prev ? (f.t - prev.t) / 2 : 0, hrSliceMaxMs));
      const fwd = Math.max(hrWindowMs, Math.min(next ? (next.t - f.t) / 2 : 0, hrSliceMaxMs));
      hrBpm = avgBpmIn(hr, f.t - back, f.t + fwd);
    }

    rows.push({
      distKm: f.cumKm,
      tSec: (f.t - t0) / 1000,
      elevM: f.alt,
      paceSecPerKm: pace,
      hr: hrBpm,
    });
  }
  return rows;
}
