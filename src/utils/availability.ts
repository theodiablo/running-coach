// Availability helpers for the Plan page's redesigned "Your availability" editor.
//
// The editor offers two modes:
//  - Simple: pick a number of run days (1–6) and a duration band, and let the
//    coach place the days. This is the beginner default.
//  - Custom: pick exact days and per-day durations (the classic scheduler).
//
// buildPlan only understands concrete PlanSessionInput[] ({dayOffset, minutes}),
// so Simple mode is resolved to a concrete layout here. Layouts mirror the
// day-spreads already proven in suggestPlanSessions (src/utils/planStyles.ts):
// the weekend (Sunday, dayOffset 6) is strictly the longest, weekday minutes come
// from the SessionConfigurator option set, and quality days sit ≥2 from Sunday so
// the plan validator places them without demotions.
import { suggestPlanSessions } from "./planStyles";
import type { PlanSessionInput } from "./plan";

export type DurationBand = "short" | "med" | "long";
export type AvailabilityMode = "simple" | "custom";

export const isBand = (v: unknown): v is DurationBand => v === "short" || v === "med" || v === "long";

export const AVAIL_DAY_MIN = 1;
export const AVAIL_DAY_MAX = 6;

// Weekly-load meter scale (minutes) for a short race (≤10 km). Matches the
// design handoff: full scale is 6h/week; the "good for a first race" band is
// 65–225 min.
export const LOAD_MAX_MIN = 360;
export const LOAD_GOOD_LO = 65;
export const LOAD_GOOD_HI = 225;

export type LoadBands = { goodLo: number; goodHi: number; maxMin: number };

// The meter's copy claims distance-specific guidance ("Below the minimum for a
// {{dist}} km build"), so the thresholds must actually move with the distance:
// a half needs more than a 5K week, a marathon more still.
export function loadBands(distanceKm?: number | string): LoadBands {
  const d = Number(distanceKm) || 0;
  if (d > 25) return { goodLo: 180, goodHi: 420, maxMin: 540 };
  if (d > 12) return { goodLo: 120, goodHi: 300, maxMin: 420 };
  return { goodLo: LOAD_GOOD_LO, goodHi: LOAD_GOOD_HI, maxMin: LOAD_MAX_MIN };
}

// Weekday vs long-run (Sunday) minutes per band. Both are option-set values and
// long > weekday so Sunday stays strictly the longest session.
const BAND_MINUTES: Record<DurationBand, { weekday: number; long: number }> = {
  short: { weekday: 30, long: 45 },
  med:   { weekday: 45, long: 75 },
  long:  { weekday: 60, long: 90 },
};

// Day layouts (dayOffset 0=Mon … 6=Sun) by run-day count. Sunday is always the
// long day; weekday picks keep quality days clear of the weekend.
const DAY_LAYOUTS: Record<number, number[]> = {
  1: [6],
  2: [2, 6],
  3: [1, 3, 6],
  4: [0, 2, 4, 6],
  5: [0, 2, 4, 5, 6],
  6: [0, 1, 2, 3, 4, 6],
};

export const clampDays = (n: number) =>
  Math.max(AVAIL_DAY_MIN, Math.min(AVAIL_DAY_MAX, Math.round(n)));

// Representative per-day minutes used only for the Simple-mode load estimate
// (the actual sessions vary the long run — see sessionsFromSimple).
export const bandRepMinutes = (band: DurationBand): number =>
  ({ short: 30, med: 52, long: 75 })[band];

// Resolve a Simple-mode selection to concrete training sessions for buildPlan.
export function sessionsFromSimple(days: number, band: DurationBand): PlanSessionInput[] {
  const d = clampDays(days);
  const layout = DAY_LAYOUTS[d] || DAY_LAYOUTS[3];
  const { weekday, long } = BAND_MINUTES[band];
  return layout.map(dayOffset => ({
    dayOffset,
    minutes: dayOffset === 6 ? long : weekday,
  }));
}

// A sensible Simple-mode starting point from the race distance + self-reported
// level, used by onboarding (before any runs exist). The day count is derived
// from suggestPlanSessions (src/utils/planStyles.ts) — the one day-count
// heuristic — so Simple and Custom suggestions can't drift; the band scales
// with distance and experience.
export function suggestSimpleAvailability(distanceKm: number | string, level?: unknown): { days: number; band: DurationBand } {
  const d = Number(distanceKm) || 5;
  const experienced = level === "regular" || level === "frequent";
  const days = clampDays(suggestPlanSessions(d, level).length);
  const band: DurationBand = experienced ? (d > 15 ? "long" : "med") : (d <= 7.5 ? "short" : "med");
  return { days, band };
}

export type LoadResult = { totalMin: number; pct: number; zone: "low" | "good" | "high" };

// Weekly training-time estimate + which zone it lands in for the race distance
// (absent distance = the short-race bands). Custom sums the exact per-day
// durations; Simple approximates as days × representative minutes.
export function weeklyLoad(
  input:
    | { mode: "custom"; sessions: PlanSessionInput[]; distanceKm?: number | string }
    | { mode: "simple"; days: number; band: DurationBand; distanceKm?: number | string },
): LoadResult {
  const bands = loadBands(input.distanceKm);
  const totalMin = input.mode === "custom"
    ? input.sessions.reduce((sum, s) => sum + (s.minutes || 0), 0)
    : clampDays(input.days) * bandRepMinutes(input.band);
  const pct = Math.max(0, Math.min(100, Math.round((totalMin / bands.maxMin) * 100)));
  const zone = totalMin < bands.goodLo ? "low" : totalMin <= bands.goodHi ? "good" : "high";
  return { totalMin, pct, zone };
}
