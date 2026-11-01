// Race-prediction maths: project finish times from logged runs.
import { VERT_COST } from "../constants";
import { hrZoneBpm } from "./hr";
type Point = { x: number; y: number };
type PredictRun = { km: number; durationSec?: number; elevation?: number | null; hr?: number | null; date?: string; type?: string };
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

// Grade-adjusted (flat-equivalent) distance: each metre ascended counts as ~VERT_COST
// extra flat metres (~1.8 flat km per km at +10% grade). Only total gain is logged, so
// this is an average-cost approximation, but it keeps hilly runs from looking unfit.
export const flatEqKm = (r: Pick<PredictRun, "km" | "elevation">) => r.km + ((r.elevation ?? 0) > 0 ? VERT_COST * (r.elevation ?? 0) / 1000 : 0);

// Pick the strongest logged effort: each qualifying run (>=3 km, with a duration) is
// normalised to its Riegel-equivalent 10 km time and the smallest wins, so a fast 1 km
// blip can't outrank a strong 12 km run. Distances are flat-equivalent.
// Returns {km, durationSec, raw} or null (km is flat-eq).
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
// A run can be accidentally slow — walk breaks, red lights, a dog, a photo stop —
// but never accidentally fast, so slow-side outliers are trimmed one-sidedly at
// this many MADs off the median pace. Their HR barely drops while their pace
// collapses, which is the single biggest source of scatter in a real log.
const SLOW_TRIM_MAD = 2.5;
// Prior on the pace/HR slope, as a share of mean pace per full heart-rate
// reserve: ~5:00/km at 70% HRR and ~4:00/km at 88% is ~1.4 mean-paces per
// reserve, and it self-scales — the same bpm is a bigger effort step for a
// runner with a narrow reserve.
export const PRIOR_PACE_PER_RESERVE = 1.4;
// Prior SD as a share of the prior slope: wide enough that a runner whose data
// genuinely disagrees is believed, tight enough to carry a base-building log.
const PRIOR_SLOPE_CV = 0.5;
// The blended slope may not exceed this multiple of the prior — a backstop
// against a leverage point in data too clean to shrink, not a tuner.
const MAX_SLOPE_OVER_PRIOR = 1.5;
// How far past the hardest effort actually logged the line may be read. Beyond
// this the answer is the fit's opinion, not the runner's data.
const MAX_EXTRAP_BPM = 8;
// The HR model is allowed to outrun the best logged effort — that is the whole
// point — but not by more than this. A backstop against absurdity, not a tuner.
const MAX_GAIN_OVER_BEST = 1.25;
// Fewest runs with an avg HR the fit will speak from, and the bpm spread of
// efforts it needs across them — below either, one run's terrain sets the line.
const MIN_FIT_RUNS = 8;
const MIN_FIT_SPREAD = 15;
// Predicted-pace uncertainty (1σ) above this share of the predicted pace means
// the data can't support an extrapolation at all; the caller hides the model.
const MAX_SE_FRAC = 0.10;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Heart-rate model: fit pace (sec/km) against avg HR, read off the pace at threshold HR
// (top of Z4), anchored as {km in 3600 s, 3600 s} for Riegel. The slope is NOT least-squares
// but blended with a physiological prior (easy-only logs make OLS noise), and extrapolation
// is bounded (see MAX_EXTRAP_BPM). Gate with `hrModelUsable`; docs/race-predictions.md.
export const hrModelAnchor = (runs: PredictRun[], effMax: number, restHR: number, best?: {km: number; durationSec: number} | null): HrAnchor | null => {
  if (!effMax) return null;
  const hrr = effMax - restHR;
  const thr = hrZoneBpm(0.88, 0.90, effMax, restHR);
  const floor = hrZoneBpm(FIT_HR_FLOOR_PCT, 0.70, effMax, restHR);
  if (!thr || !floor || hrr <= 0) return null;
  // y is grade-adjusted pace: a hilly run's slow pace at high HR becomes a fast
  // flat-equivalent pace at high HR, consistent with the rest of the data.
  const all = runs
    .filter(r => r.km >= 2 && r.durationSec && r.hr && (r.hr ?? 0) >= floor.lo && String(r.type ?? "").toUpperCase() !== "WALK")
    .map(r => ({x: r.hr ?? 0, y: (r.durationSec ?? 0) / flatEqKm(r)}));
  if (!all.length) return null;
  const mid = median(all.map(p => p.y));
  const mad = median(all.map(p => Math.abs(p.y - mid))) || 0;
  const pts = mad > 0 ? all.filter(p => p.y <= mid + SLOW_TRIM_MAD * mad) : all;
  const fit = linReg(pts);
  if (!fit) return null;
  const hrs = pts.map(p => p.x);
  const maxHR = Math.max(...hrs);
  const spread = maxHR - Math.min(...hrs);

  // Precision-weighted blend of the fitted slope and the physiological prior,
  // through the fit's centroid. resSd null (n ≤ 2) means no residual estimate at
  // all, so the prior stands alone; resSd 0 is a perfect line, which keeps its own.
  const priorSlope = -PRIOR_PACE_PER_RESERVE * fit.my / hrr;
  const priorPrec = 1 / (PRIOR_SLOPE_CV * priorSlope) ** 2;
  const dataPrec = fit.resSd == null ? 0 : fit.resSd > 0 ? fit.sxx / fit.resSd ** 2 : Infinity;
  const blended = dataPrec === Infinity ? fit.b : (dataPrec * fit.b + priorPrec * priorSlope) / (dataPrec + priorPrec);
  const slope = Math.max(blended, MAX_SLOPE_OVER_PRIOR * priorSlope);
  const slopeSd = dataPrec === Infinity ? 0 : Math.sqrt(1 / (dataPrec + priorPrec));
  const atHR = Math.min(thr.lo, maxHR + MAX_EXTRAP_BPM);
  const thrPace = fit.my + slope * (atHR - fit.mx);
  if (thrPace <= 0) return null;

  // Same shape as `seAt`, with the blended slope's SD in place of the fit's own.
  const se = fit.resSd == null ? null
    : Math.sqrt((fit.resSd ** 2) / fit.n + (slopeSd * (atHR - fit.mx)) ** 2);
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
  !!hr && hr.n >= MIN_FIT_RUNS && hr.spread >= MIN_FIT_SPREAD && hr.slope < 0
  && hr.se != null && hr.se <= MAX_SE_FRAC * hr.thrPace;

// Which gate a hidden model is failing, so the locked state can name it. "It
// needs more data" with no idea which kind reads as broken to a runner who has
// been logging for months.
export type HrBlocker = "noData" | "few" | "spread" | "flat" | "scatter";
export const hrModelBlocker = (hr: HrAnchor | null): HrBlocker | null => {
  if (!hr) return "noData";
  if (hr.n < MIN_FIT_RUNS) return "few";
  if (hr.spread < MIN_FIT_SPREAD) return "spread";
  if (hr.slope >= 0) return "flat";
  if (hr.se == null || hr.se > MAX_SE_FRAC * hr.thrPace) return "scatter";
  return null;
};

// What a blocked model still needs, for the locked copy: runs short of the
// minimum, and bpm short of the required spread of efforts.
export const hrModelGap = (hr: HrAnchor | null) => ({
  runs: Math.max(0, MIN_FIT_RUNS - (hr?.n ?? 0)),
  bpm: Math.max(0, MIN_FIT_SPREAD - (hr?.spread ?? 0)),
});
