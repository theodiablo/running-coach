// Training-plan methodology styles: app-side catalogue and helpers.
//
// The PACE multipliers live with the edge function in
// supabase/functions/_shared/coach/styles.mjs (single source of truth shared
// with the coach agent, same dual-import pattern as coachValidation.ts) and
// are re-exported here. Everything else — plan-shape parameters, the style
// picker metadata, the profile-based recommendation — is app-only, because the
// coach never rebuilds weeks.
// @ts-expect-error Shared Deno/Vitest ESM has no TypeScript declaration file.
import * as sharedStyles from "../../supabase/functions/_shared/coach/styles.mjs";
import { t } from "../i18n";
import { ymd } from "./format";
import { isCrossTraining } from "../types";
import type { PlanSessionInput } from "./plan";

export type StyleId = "balanced" | "polarized" | "runwalk" | "lowfreq" | "hansons";
export type StylePacing = { easy: number; tempo: number; intervals: number; long: number; walk: number | null };

type StylesExports = {
  DEFAULT_STYLE: StyleId;
  STYLE_PACING: Record<StyleId, StylePacing>;
  stylePacing: (style: unknown) => StylePacing;
  styleNotes: (style: unknown) => string;
};
const styles = sharedStyles as StylesExports;

export const { DEFAULT_STYLE, STYLE_PACING, stylePacing, styleNotes } = styles;

// The APP-side list of usable styles, deliberately NOT re-exported from
// styles.mjs: buildPlan and StylePicker index STYLE_SHAPE / styleMeta /
// COMPOSERS, which are all Record<StyleId, …> — complete by type. Keying off
// the shared list instead would let a style added server-side first pass
// isStyleId and then crash the app-side lookups; this way such a style simply
// isn't offered/built until the app maps ship, and unknown ids keep degrading
// to balanced everywhere.
export const STYLE_IDS: StyleId[] = ["balanced", "polarized", "runwalk", "lowfreq", "hansons"];

export const isStyleId = (v: unknown): v is StyleId =>
  typeof v === "string" && (STYLE_IDS as string[]).includes(v);

// Picker metadata — label + one-line blurb per style. A function (not a const
// map) so the strings resolve in the active UI language at render time.
export const styleMeta = (id: StyleId): { label: string; blurb: string } => ({
  label: t(`styles.meta.${id}.label`),
  blurb: t(`styles.meta.${id}.blurb`),
});

// ── Plan-shape parameters ────────────────────────────────────────────────────
// peakLong receives the race distance and an estimate of the configured weekly
// volume (km at the style's easy pace) so a style can cap the long run as a
// share of weekly volume (Hansons) instead of race distance alone.
export type StyleShape = {
  peakLong: (dist: number, estWeeklyKm: number) => number;
  taperMults: [number, number, number];
  floorKm: number; // minimum starting long run when there's no recent-run floor
  cutbackEvery3: boolean; // Galloway-style down-week every 3rd week of the ramp
};

// The pre-styles formula: ~0.9× for short/half, ~0.78× marathon (capped 32),
// 36 km hard ceiling for ultras. Kept verbatim — balanced must not change.
const balancedPeak = (dist: number) =>
  Math.min(36, dist <= 25 ? dist * 0.9 : dist <= 43 ? Math.min(32, dist * 0.78) : 34);

const CLASSIC_TAPER: [number, number, number] = [0.85, 0.65, 0.45];

export const STYLE_SHAPE: Record<StyleId, StyleShape> = {
  balanced: { peakLong: balancedPeak, taperMults: CLASSIC_TAPER, floorKm: 4.5, cutbackEvery3: false },
  polarized: { peakLong: balancedPeak, taperMults: CLASSIC_TAPER, floorKm: 4.5, cutbackEvery3: false },
  runwalk: {
    // Finish-focused: shorter peak (never above 26 km even for a marathon+).
    peakLong: (dist) => (dist <= 25 ? dist * 0.75 : Math.min(26, dist * 0.62)),
    taperMults: [0.8, 0.6, 0.4],
    floorKm: 3,
    cutbackEvery3: true,
  },
  lowfreq: { peakLong: balancedPeak, taperMults: CLASSIC_TAPER, floorKm: 4.5, cutbackEvery3: false },
  hansons: {
    // Capped long run: ≤26 km, never above the classic peak, ~28% of the
    // configured weekly volume. The floor is itself volume-bounded (≤40% of
    // weekly km, up to 12) — a bare 12 km floor would hand a 2-short-days
    // config a long run that IS the whole week, the opposite of the style.
    peakLong: (dist, estWeeklyKm) =>
      Math.min(26, balancedPeak(dist),
        Math.max(0.28 * estWeeklyKm, Math.min(12, 0.4 * estWeeklyKm))),
    taperMults: CLASSIC_TAPER,
    floorKm: 4.5,
    cutbackEvery3: false,
  },
};

// ── Hard-day placement ──────────────────────────────────────────────────────
// Pick up to `count` quality days for hard sessions, keeping every hard day
// (the long run included) at least 2 calendar days from the others so the
// validator's no-hard-back-to-back rule holds by construction — including
// across the week wrap (Sun long → Mon quality), hence circular distance.
// Greedy: repeatedly take the candidate with the largest minimum circular gap
// to the hard days chosen so far. May return fewer than `count` when the
// configured days are too dense; the leftover days simply stay easy.
const circGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 7;
  return Math.min(d, 7 - d);
};

export function pickHardDays(qualityDays: number[], longDay: number, count: number): number[] {
  const picked: number[] = [];
  const pool = qualityDays.slice();
  while (picked.length < count && pool.length) {
    let bestIdx = -1;
    let bestGap = -1;
    pool.forEach((day, i) => {
      const gap = Math.min(...[longDay, ...picked].map((h) => circGap(day, h)));
      if (gap > bestGap) {
        bestGap = gap;
        bestIdx = i;
      }
    });
    if (bestGap < 2) break; // nothing left that can sit clear of the hard days
    picked.push(pool.splice(bestIdx, 1)[0]);
  }
  return picked;
}

// ── Self-reported training level ────────────────────────────────────────────
// Onboarding's one-question fitness signal ("How much do you run right now?").
// It substitutes for run history where none exists yet: recommendStyle uses it
// to unlock the volume-gated styles for experienced runners new to the APP,
// and buildPlan uses startLongKm as a fitness-aware starting long run the same
// way a recent logged long run would be. Real logged runs always win over it.
export type TrainingLevel = "none" | "occasional" | "regular" | "frequent";

const TRAINING_LEVEL_IDS: TrainingLevel[] = ["none", "occasional", "regular", "frequent"];

// Level tiles in display order — a function so labels follow the UI language.
export const trainingLevels = (): { id: TrainingLevel; label: string; sub: string }[] =>
  TRAINING_LEVEL_IDS.map((id) => ({
    id,
    label: t(`styles.levels.${id}.label`),
    sub: t(`styles.levels.${id}.sub`),
  }));

export const isTrainingLevel = (v: unknown): v is TrainingLevel =>
  typeof v === "string" && (TRAINING_LEVEL_IDS as string[]).includes(v);

// Synthetic history equivalents per level — deliberately conservative bands.
const LEVEL_PROFILE: Record<TrainingLevel, { weeklyKm: number; runCount: number; startLongKm: number }> = {
  none: { weeklyKm: 0, runCount: 0, startLongKm: 0 },
  occasional: { weeklyKm: 8, runCount: 2, startLongKm: 4 },
  regular: { weeklyKm: 25, runCount: 3, startLongKm: 8 },
  frequent: { weeklyKm: 40, runCount: 5, startLongKm: 12 },
};

// Starting-long-run hint for buildPlan; 0 for unknown/absent levels.
export const levelStartLongKm = (level: unknown): number =>
  isTrainingLevel(level) ? LEVEL_PROFILE[level].startLongKm : 0;

// ── Suggested training days/durations ───────────────────────────────────────
// A sensible days-and-minutes layout for the race distance and self-reported
// level, so a user with no preference never has to assemble the week by hand.
// Invariants: minutes come from SessionConfigurator's fixed option set; the
// Sunday session is strictly the longest (buildPlan makes the longest day the
// long run); quality candidates sit ≥2 days from Sunday so every style's
// pickHardDays placement works without demotions.
export function suggestPlanSessions(distanceKm: number | string, level?: unknown): PlanSessionInput[] {
  const d = Number(distanceKm) || 5;
  const lvl: TrainingLevel = isTrainingLevel(level) ? level : "occasional";
  const experienced = lvl === "regular" || lvl === "frequent";
  const days = lvl === "frequent" ? (d > 12 ? 5 : 4) : lvl === "regular" && d > 12 ? 4 : 3;
  // ≥4-day layouts carry 45-60 min weekday sessions, so their long day floors
  // at 75 min to stay strictly the longest (buildPlan keys the long run on it).
  const longMin = Math.max(days >= 4 ? 75 : 0,
    d > 25 ? (experienced ? 120 : 90) : d > 12 ? 90 : d > 7.5 ? 60 : 45);
  if (days === 5) return [
    { dayOffset: 0, minutes: 45 }, { dayOffset: 2, minutes: 60 },
    { dayOffset: 4, minutes: 45 }, { dayOffset: 5, minutes: 30 },
    { dayOffset: 6, minutes: longMin },
  ];
  if (days === 4) return [
    { dayOffset: 0, minutes: 30 }, { dayOffset: 2, minutes: 45 },
    { dayOffset: 4, minutes: 45 }, { dayOffset: 6, minutes: longMin },
  ];
  return [
    { dayOffset: 1, minutes: d > 7.5 ? 45 : 30 }, { dayOffset: 3, minutes: d > 7.5 ? 45 : 30 },
    { dayOffset: 6, minutes: longMin },
  ];
}

// ── Profile-based recommendation ────────────────────────────────────────────
// Pure: derives a suggested style from what the app already knows. Mirrors
// buildPlan's 35-day recent window. First match wins; `balanced` is the
// fallback, so brand-new users (no data at all) get the current behaviour.
type RecentRunLike = { date?: string; km?: number; type?: string };

// Masters threshold: from ~this age the recommendation favours recovery-rich
// shapes (lowfreq) and avoids cumulative-fatigue ones (hansons). Age never
// blocks a style — StylePicker still offers them all; absent age changes nothing.
export const MASTERS_AGE = 57;

export function recommendStyle(input: {
  intent?: string | null;
  planSessions?: PlanSessionInput[];
  distanceKm?: number | string;
  recentRuns?: RecentRunLike[];
  level?: unknown; // self-reported TrainingLevel; used only when no recent runs
  age?: number | null; // derived runner age (runnerAge in src/utils/hr.ts); null = unknown
  today?: Date; // injectable for deterministic tests
}): StyleId {
  const today = input.today ?? new Date();
  const cutoff = ymd(new Date(today.getTime() - 35 * 86400000));
  // Cross-training is excluded outright: its distance isn't running volume, and
  // this average is what steers the recommended style's paces.
  const recent = (input.recentRuns || []).filter(
    (r) => r && r.date && r.date >= cutoff && (r.km ?? 0) > 0 && !isCrossTraining(r),
  );
  let runCount = recent.length;
  // Weekly volume over the weeks that actually have data — a fixed /5 would
  // halve the real load of a runner with only 2 weeks of history and steer
  // them to a gentler style than they train for.
  const earliest = recent.reduce((m, r) => (r.date && r.date < m ? r.date : m), ymd(today));
  const spanWeeks = Math.min(5, Math.max(1,
    (today.getTime() - new Date(earliest + "T00:00:00").getTime()) / (7 * 86400000)));
  let weeklyKm = recent.reduce((s, r) => s + (r.km ?? 0), 0) / spanWeeks;
  // No logged history (typically onboarding): fall back to the self-reported
  // level so an experienced runner new to the app isn't funnelled to balanced.
  if (!runCount && isTrainingLevel(input.level)) {
    ({ weeklyKm, runCount } = LEVEL_PROFILE[input.level]);
  }
  const days = input.planSessions?.length ?? 0;
  const dist = Number(input.distanceKm) || 0;
  const masters = (input.age ?? 0) >= MASTERS_AGE;

  // True beginner (or long break): little recent running, and either a fitness
  // goal or a short race. Never auto-recommended for a long race — run/walk is
  // legitimate for a marathon (Galloway) but that's an explicit choice.
  if (runCount < 4 && weeklyKm < 10 && (input.intent === "fitness" || (dist > 0 && dist <= 10.5)))
    return "runwalk";
  // Masters returning from little recent running: gentle on-ramp — run/walk for
  // short goals, low frequency (not run/walk) for longer races.
  if (masters && runCount < 4 && weeklyKm < 15) return dist > 10.5 ? "lowfreq" : "runwalk";
  // Time-crunched but trained: exactly 3 days with real volume behind them.
  // Masters qualify without the volume gate — the recovery-day-rich week is
  // the point at that age, not a consolation for low mileage.
  if (days === 3 && (weeklyKm >= 20 || masters)) return "lowfreq";
  // High frequency + long race + real volume. Hansons' cumulative-fatigue
  // design is the one shape deliberately not auto-recommended for masters.
  if (!masters && days >= 5 && dist >= 21 && weeklyKm >= 35) return "hansons";
  // Decent frequency and volume: polarized is the best-evidenced default.
  if (days >= 4 && weeklyKm >= 25) return "polarized";
  return "balanced";
}
