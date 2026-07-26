// Race-prediction maths: project finish times from logged runs.
import { VERT_COST } from "../constants";
import { hrZoneBpm } from "./hr";
type Point = { x: number; y: number };
type PredictRun = { km: number; durationSec?: number; elevation?: number | null; hr?: number | null; date?: string };
type EffortAnchor = { km: number; durationSec: number; eq: number; raw: PredictRun };
type HrAnchor = {
  km: number; durationSec: number; r2: number; slope: number; n: number; spread: number;
  thrHR: number; atHR: number; thrPace: number; se: number | null; capped: boolean; clamped: boolean;
};

const RIEGEL_K = 1.06;

// Peter Riegel's endurance race-time formula: project a known time t1 over
// distance d1 to a target distance d2. The 1.06 exponent is the standard
// "fatigue factor" — going further costs slightly more than linear time.
export const riegel = (t1: number, d1: number, d2: number, k = RIEGEL_K) => t1 * Math.pow(d2 / d1, k);

// Riegel solved for distance instead of time: how far the anchor projects to in
// `sec`. Used to compare two anchors on one scale (km covered in an hour).
export const riegelKm = (t1: number, d1: number, sec: number) => d1 * Math.pow(sec / t1, 1 / RIEGEL_K);

// Grade-adjusted (flat-equivalent) distance. A hilly run is slower than its flat
// twin at the same effort, so we credit the climb by treating each metre ascended
// as ~VERT_COST extra metres of flat running. We only log total gain (no descent
// or profile), so this is an average-cost approximation — but it stops hilly runs
// from looking unfit, which sharpens both the best-effort pick and the HR fit.
// At ~+10% grade this counts a km as ~1.8 flat km, in line with GAP rules of thumb.
export const flatEqKm = (r: Pick<PredictRun, "km" | "elevation">) => r.km + ((r.elevation ?? 0) > 0 ? VERT_COST * (r.elevation ?? 0) / 1000 : 0);

// Pick the runner's strongest logged effort. We don't just take the lowest raw
// pace — a fast 1 km blip shouldn't outrank a strong 12 km run — so each
// qualifying run (≥3 km, with a duration) is normalised to its Riegel-equivalent
// 10 km time and the best (smallest) one wins. Distances are flat-equivalent so a
// strong hilly run can win. Returns {km, durationSec, raw} or null (km is flat-eq).
export const bestEffortAnchor = (runs: PredictRun[]) => runs
  .filter(r => r.km >= 3 && r.durationSec)
  .reduce<EffortAnchor | null>((best, r) => {
    const eqKm = flatEqKm(r);
    const eq = riegel(r.durationSec ?? 0, eqKm, 10);
    return (!best || eq < best.eq) ? {km: eqKm, durationSec: r.durationSec ?? 0, eq, raw: r} : best;
  }, null);

// Least-squares linear fit y = a + b·x, plus R² so callers can judge the fit.
// Also returns the centroid, sxx and the residual SD — what `seAt` needs to say
// how uncertain a prediction is, which matters far more than R² when the caller
// reads the line off past the edge of the data.
export const linReg = (pts: Point[]) => {
  const n = pts.length;
  if (n < 2) return null;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  pts.forEach(p => { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); syy += (p.y - my) ** 2; });
  if (sxx === 0) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  const resSd = n > 2 ? Math.sqrt(Math.max(0, syy - b * sxy) / (n - 2)) : null;
  return {a, b, r2, n, mx, my, sxx, resSd};
};

// Standard error of the fitted line at x — grows with distance from the data's
// centre, which is exactly the penalty an extrapolation deserves.
export const seAt = (fit: NonNullable<ReturnType<typeof linReg>>, x: number) =>
  fit.resSd == null ? null : fit.resSd * Math.sqrt(1 / fit.n + (x - fit.mx) ** 2 / fit.sxx);

// Recovery-zone (Z1) sessions are walk-and-stroll efforts, not points on the
// same pace/HR line as running — and sitting 25+ bpm below everything else they
// dominate a least-squares fit. Excluded, so the line describes actual running.
const FIT_HR_FLOOR_PCT = 0.60; // bottom of Z2
// Pace cannot keep buying time indefinitely per extra bpm. Cap the fitted slope
// at 1% of the runner's mean pace per bpm (~4 s/km/bpm at 7:00/km) — steeper
// than that is noise or a leverage point, not physiology.
const MAX_SLOPE_FRAC = 0.01;
// How far past the hardest effort actually logged the line may be read. Beyond
// this the answer is the fit's opinion, not the runner's data.
const MAX_EXTRAP_BPM = 8;
// The HR model is allowed to outrun the best logged effort — that is the whole
// point — but not by more than this. A backstop against absurdity, not a tuner.
const MAX_GAIN_OVER_BEST = 1.25;
// Predicted-pace uncertainty (1σ) above this share of the predicted pace means
// the data can't support an extrapolation at all; the caller hides the model.
const MAX_SE_FRAC = 0.10;

// Heart-rate model. Across the runs that recorded an avg HR, fit pace (sec/km)
// against HR — easy low-HR runs anchor the slow end, hard high-HR runs the fast
// end — then read off the pace the runner could hold at their threshold HR
// (top of Z4). Threshold effort is roughly a 1-hour race, so we anchor it as
// {km covered in 3600 s, 3600 s} for Riegel to project from. A fast pace held at
// a low HR therefore pulls the predicted threshold pace faster ("handled well"),
// and vice-versa.
//
// Reading a straight line off past the end of the data is where this gets
// dangerous, so the extrapolation is bounded three ways — Z1 points dropped, the
// slope capped, and the read-off HR held within MAX_EXTRAP_BPM of the hardest
// effort logged — then sanity-clamped against `best` when one is supplied.
// Returns the anchor plus fit stats; gate it with `hrModelUsable`.
export const hrModelAnchor = (runs: PredictRun[], effMax: number, restHR: number, best?: {km: number; durationSec: number} | null): HrAnchor | null => {
  if (!effMax) return null;
  const thr = hrZoneBpm(0.88, 0.90, effMax, restHR);
  const floor = hrZoneBpm(FIT_HR_FLOOR_PCT, 0.70, effMax, restHR);
  if (!thr || !floor) return null;
  // y is grade-adjusted pace: a hilly run's slow pace at high HR becomes a fast
  // flat-equivalent pace at high HR, consistent with the rest of the data.
  const pts = runs
    .filter(r => r.km >= 2 && r.durationSec && r.hr && (r.hr ?? 0) >= floor.lo)
    .map(r => ({x: r.hr ?? 0, y: (r.durationSec ?? 0) / flatEqKm(r)}));
  const fit = linReg(pts);
  if (!fit) return null;
  const hrs = pts.map(p => p.x);
  const maxHR = Math.max(...hrs);
  const spread = maxHR - Math.min(...hrs);

  // Cap the slope through the fit's centroid: same data, gentler line.
  const slope = Math.max(fit.b, -MAX_SLOPE_FRAC * fit.my);
  const atHR = Math.min(thr.lo, maxHR + MAX_EXTRAP_BPM);
  const thrPace = fit.my + slope * (atHR - fit.mx);
  if (thrPace <= 0) return null;

  const se = seAt(fit, atHR);
  const bestKm = best?.durationSec ? riegelKm(best.durationSec, best.km, 3600) : 0;
  const km = Math.min(3600 / thrPace, bestKm > 0 ? bestKm * MAX_GAIN_OVER_BEST : Infinity);
  return {
    km, durationSec: 3600, r2: fit.r2, slope, n: pts.length, spread,
    thrHR: thr.lo, atHR, thrPace, se,
    capped: atHR < thr.lo,          // read off short of threshold HR
    clamped: km < 3600 / thrPace,   // the best-effort backstop bit
  };
};

// Whether the HR model earned the right to be shown: enough runs, a real spread
// of efforts, pace genuinely improving with HR, and a prediction precise enough
// to be worth printing.
export const hrModelUsable = (hr: HrAnchor | null): hr is HrAnchor =>
  !!hr && hr.n >= 8 && hr.spread >= 15 && hr.slope < 0
  && hr.se != null && hr.se <= MAX_SE_FRAC * hr.thrPace;
