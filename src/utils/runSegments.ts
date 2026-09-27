// Running-only figures for a run that alternates running and walking (a
// Galloway session, or any run with walk breaks in it). The whole-run average
// pace of a run/walk session describes neither half of it: the runner wants to
// know how fast the RUNNING was.
//
// Nothing on a saved run says which seconds were walked — the only record is the
// trace itself — so this segments the trace by its own pace distribution
// (weighted 2-means over the legs between stored points, time-weighted) rather
// than against an absolute "walking is slower than X" threshold, which no single
// figure can be: a beginner runs at 9:00/km and a fit runner walks at 8:00/km.
//
// It is therefore an ESTIMATE and the UI must say so. It returns null unless the
// run really does read as two modes (see the gates below) — a steady run has one
// mode and gets no card at all, which is the honest answer.
//
// Pure and unit-tested. Points are the stored [lat,lng,t,alt] tuples with null
// gap markers, exactly as buildSplits/buildRunSeries read them.

import { flattenTrack } from "./geo";
import type { TrackPointOrGap } from "./geo";
import type { HrSample } from "./runSeries";

export type RunWalkPart = {
  km: number;
  durationSec: number;
  paceSecPerKm: number;
  avgHr: number | null;
  /** How many separate bouts of this kind the run contains. */
  bouts: number;
};

export type RunWalkBreakdown = {
  run: RunWalkPart;
  walk: RunWalkPart;
  /** The pace (sec/km) the split was drawn at — running is everything faster. */
  cutSecPerKm: number;
};

type Leg = { km: number; sec: number; pace: number; t0: number; t1: number; run: boolean };

// A leg longer than this is a pause or a swallowed gap, not a stride — it would
// otherwise weigh minutes of standing still into the walk cluster.
const MAX_LEG_SEC = 45;
// Slower than this is not a mode of anything, just a stop with the watch running.
const PACE_CAP = 1500;
// A bout this short is sampling noise at a boundary, not a change of gait.
const MIN_BOUT_SEC = 12;

// Gates. All of them must hold, or the run doesn't read as run/walk and we say
// nothing rather than inventing a split.
const MIN_MOVING_SEC = 240;
const MIN_SEPARATION_SEC = 60;      // absolute gap between the two cluster paces
const MIN_SEPARATION_RATIO = 1.25;  // ...and a relative one, so slow runs qualify too
const MIN_SHARE = 0.08;             // each mode must own this much of the moving time
const MIN_BOUTS = 2;                // a real alternation, not one stop for a road crossing
const RUN_PACE_MAX = 660;           // 11:00/km — slower than this, the "fast" mode is walking

// Time-weighted percentile of the legs' paces — the k-means seeds.
function weightedPercentile(legs: Leg[], p: number): number {
  const total = legs.reduce((s, l) => s + l.sec, 0);
  if (!total) return 0;
  const sorted = legs.slice().sort((a, b) => a.pace - b.pace);
  let acc = 0;
  for (const l of sorted) {
    acc += l.sec;
    if (acc >= total * p) return l.pace;
  }
  return sorted[sorted.length - 1].pace;
}

// Two clusters over pace, weighted by how long each leg lasted (a 30 s leg says
// more about the run than a 2 s one). Returns the two centres, fast first.
function twoMeans(legs: Leg[]): [number, number] {
  let fast = weightedPercentile(legs, 0.1);
  let slow = weightedPercentile(legs, 0.9);
  for (let i = 0; i < 40 && slow - fast > 0.5; i++) {
    const cut = (fast + slow) / 2;
    let fs = 0, fw = 0, ss = 0, sw = 0;
    for (const l of legs) {
      if (l.pace <= cut) { fs += l.pace * l.sec; fw += l.sec; }
      else { ss += l.pace * l.sec; sw += l.sec; }
    }
    if (!fw || !sw) break;
    const nf = fs / fw, ns = ss / sw;
    if (Math.abs(nf - fast) < 0.5 && Math.abs(ns - slow) < 0.5) { fast = nf; slow = ns; break; }
    fast = nf; slow = ns;
  }
  return [fast, slow];
}

// Drop bouts too short to be a change of gait into their neighbours, so a single
// slow leg mid-run doesn't count as a walk break (and back).
function smooth(legs: Leg[]): void {
  // A merge can leave its neighbour short in turn, so sweep until nothing moves
  // (bounded — each pass strictly reduces the bout count, and a handful is plenty).
  for (let pass = 0; pass < 4; pass++) {
    let merged = false;
    for (let i = 0; i < legs.length;) {
      let j = i, sec = 0;
      while (j < legs.length && legs[j].run === legs[i].run) { sec += legs[j].sec; j++; }
      // Never flip the only bout there is — that erases the split, not the noise.
      if (sec < MIN_BOUT_SEC && (i > 0 || j < legs.length)) {
        const to = i > 0 ? legs[i - 1].run : legs[j].run;
        for (let k = i; k < j; k++) legs[k].run = to;
        merged = true;
      }
      i = j;
    }
    if (!merged) return;
  }
}

function countBouts(legs: Leg[], run: boolean): number {
  let n = 0;
  for (let i = 0; i < legs.length; i++)
    if (legs[i].run === run && (i === 0 || legs[i - 1].run !== run)) n++;
  return n;
}

// Mean bpm per class in ONE pass over both time-sorted streams — a multi-hour
// run has thousands of legs and thousands of samples, and this runs in a modal.
function hrByClass(legs: Leg[], samples: HrSample[] | null): { run: number | null; walk: number | null } {
  if (!samples || !samples.length) return { run: null, walk: null };
  const sum = [0, 0], n = [0, 0];
  let li = 0;
  for (const s of samples) {
    while (li < legs.length && legs[li].t1 < s.t) li++;
    if (li >= legs.length) break;
    if (s.t < legs[li].t0) continue; // inside a pause/gap between legs
    const i = legs[li].run ? 0 : 1;
    sum[i] += s.bpm; n[i]++;
  }
  return { run: n[0] ? Math.round(sum[0] / n[0]) : null, walk: n[1] ? Math.round(sum[1] / n[1]) : null };
}

function part(legs: Leg[], run: boolean, avgHr: number | null): RunWalkPart {
  let km = 0, sec = 0;
  for (const l of legs) if (l.run === run) { km += l.km; sec += l.sec; }
  return {
    km: Math.round(km * 100) / 100,
    durationSec: Math.round(sec),
    paceSecPerKm: km > 0 ? Math.round(sec / km) : 0,
    avgHr,
    bouts: countBouts(legs, run),
  };
}

export function runWalkBreakdown(
  points: TrackPointOrGap[],
  hrSamples?: HrSample[] | null,
  opts?: { jitterM?: number },
): RunWalkBreakdown | null {
  const flat = flattenTrack(points, opts?.jitterM ?? 3);
  if (flat.length < 4) return null;

  const legs: Leg[] = [];
  for (let i = 1; i < flat.length; i++) {
    if (flat[i].segStart) continue; // never bridge a GPS gap
    const km = flat[i].cumKm - flat[i - 1].cumKm;
    const sec = (flat[i].t - flat[i - 1].t) / 1000;
    if (sec <= 0 || sec > MAX_LEG_SEC || km < 0) continue;
    const pace = km > 0 ? Math.min(PACE_CAP, sec / km) : PACE_CAP;
    legs.push({ km, sec, pace, t0: flat[i - 1].t, t1: flat[i].t, run: false });
  }
  const movingSec = legs.reduce((s, l) => s + l.sec, 0);
  if (movingSec < MIN_MOVING_SEC) return null;

  const [fast, slow] = twoMeans(legs);
  if (slow - fast < MIN_SEPARATION_SEC || slow / fast < MIN_SEPARATION_RATIO) return null;
  if (fast > RUN_PACE_MAX) return null;

  const cut = (fast + slow) / 2;
  for (const l of legs) l.run = l.pace <= cut;
  smooth(legs);

  const hr = hrByClass(legs, hrSamples || null);
  const run = part(legs, true, hr.run);
  const walk = part(legs, false, hr.walk);
  if (run.durationSec < movingSec * MIN_SHARE || walk.durationSec < movingSec * MIN_SHARE) return null;
  if (run.bouts < MIN_BOUTS || walk.bouts < MIN_BOUTS) return null;
  if (!run.km || !walk.km) return null;

  return { run, walk, cutSecPerKm: Math.round(cut) };
}
