// "How this session unfolds" — the expandable step-by-step breakdown behind a
// plan-session card tap in PlanView. Pure and derived from the session row
// itself (type, sd, desc, km, pace), so it works for generated AND coach-edited
// sessions and never needs the plan or style. Labels and prose are localized via
// the bound `t`; the structured `sd` supplies rep/recovery/ratio figures when
// present, else we parse them back out of the (always-English) canonical `desc`.
// The km on a rep session is the whole outing (reps + warmup/recovery
// allowance), which is exactly the confusion this breakdown exists to answer.
import i18n, { t } from "../i18n";
import { fmt } from "./format";
import type { SessionSd } from "../types";

export type SessionStep = { label: string; detail: string };

export type RunWalkRatio = { runSec: number; walkSec: number };

type SessionLike = {
  type?: string;
  desc?: string;
  km?: number | string;
  pace?: number | string | null;
  sd?: SessionSd;
};

const L = (k: string) => t("plan.steps.labels." + k);
const stretchStep = (): SessionStep => ({ label: L("stretch"), detail: t("plan.steps.stretch") });

// Rep-distance with a space ("800 m", "3 km"), matching the parse-based form.
const sdDist = (m: number | undefined): string =>
  m == null ? "" : m % 1000 === 0 ? m / 1000 + " km" : m + " m";

// "5x800m", "3x3km", "6x400m" — the rep block a workout desc promises. One
// regex, two consumers: the localized display form here, and the raw metres
// form shared with compileWorkout (utils/workout.ts) so prose and guided
// schedule read the same figures.
const REPS_RE = /(\d+)x(\d+(?:\.\d+)?)(km|m)\b/i;

export const parseRepsRaw = (desc: string): { count: number; m: number } | null => {
  const m = desc.match(REPS_RE);
  if (!m) return null;
  return { count: Number(m[1]), m: m[3].toLowerCase() === "km" ? Number(m[2]) * 1000 : Number(m[2]) };
};

const parseReps = (desc: string) => {
  const m = desc.match(REPS_RE);
  if (!m) return null;
  return { count: Number(m[1]), dist: m[3].toLowerCase() === "km" ? m[2] + " km" : m[2] + " m" };
};

// Reps from the structured descriptor, else parsed from the English desc.
const repsFor = (s: SessionLike, desc: string) => {
  if (s.sd?.kind === "intervals" && s.sd.reps && s.sd.repM)
    return { count: s.sd.reps, dist: sdDist(s.sd.repM) };
  return parseReps(desc);
};

// A localized recovery phrase from the sd token, else parsed from the desc.
const recoveryFor = (s: SessionLike, desc: string): string => {
  const tok = s.sd?.recover;
  if (tok && i18n.exists("plan.steps.recPhrase." + tok)) return t("plan.steps.recPhrase." + tok);
  const m = desc.match(/\+\s*([^.]*recover[^.,]*)/i);
  return m ? m[1].trim() : t("plan.steps.recPhrase.default");
};

// "run 2 min / walk 1 min" parsed off the desc — the Galloway ratio's fallback
// form, shared with compileWorkout (utils/workout.ts). Seconds out, because a
// ratio can be sub-minute ("run 1 min 30 s / walk 1 min").
const DUR = "(\\d+\\s*min(?:\\s*\\d+\\s*s)?|\\d+\\s*s)";
const RATIO_RE = new RegExp("run\\s+" + DUR + "\\s*\\/\\s*walk\\s+" + DUR, "i");

const durSec = (tok: string): number => {
  const min = tok.match(/(\d+)\s*min/i);
  const sec = tok.match(/(\d+)\s*s\b/i);
  return (min ? Number(min[1]) * 60 : 0) + (sec ? Number(sec[1]) : 0);
};

export const parseRatio = (desc: string): RunWalkRatio | null => {
  const m = desc.match(RATIO_RE);
  if (!m) return null;
  const runSec = durSec(m[1]), walkSec = durSec(m[2]);
  return runSec > 0 && walkSec > 0 ? { runSec, walkSec } : null;
};

// The Galloway ratio in seconds, from sd (seconds first, then the pre-seconds
// whole-minute fields) else parsed from the English desc. The one reader — also
// used by compileWorkout, so prose and guided schedule can't quote different
// figures.
export const runwalkRatio = (s: SessionLike, desc: string): RunWalkRatio | null => {
  const sd = s.sd;
  if (sd?.kind === "runwalk") {
    if (sd.runSec != null && sd.walkSec != null) return { runSec: sd.runSec, walkSec: sd.walkSec };
    if (sd.runMin != null && sd.walkMin != null) return { runSec: sd.runMin * 60, walkSec: sd.walkMin * 60 };
  }
  return parseRatio(desc);
};

// The localized sentence figures for a ratio.
const ratioTokens = (r: RunWalkRatio) => ({ run: fmt.interval(r.runSec), walk: fmt.interval(r.walkSec) });

export function sessionSteps(s: SessionLike): SessionStep[] {
  const type = String(s.type || "");
  const desc = String(s.desc || "");
  const km = Number(s.km) || 0;
  const pace = Number(s.pace) || 0;
  const paceTxt = pace ? fmt.pace(pace) + "/km" : null;

  if (type === "INTERVALS") {
    const reps = repsFor(s, desc);
    const workout = reps
      ? t(paceTxt ? "plan.steps.intervals.workoutReps" : "plan.steps.intervals.workoutRepsNoPace",
          { count: reps.count, dist: reps.dist, pace: paceTxt, recovery: recoveryFor(s, desc) })
      : t(paceTxt ? "plan.steps.intervals.workoutGeneric" : "plan.steps.intervals.workoutGenericNoPace",
          { pace: paceTxt });
    return [
      { label: L("warmup"), detail: t("plan.steps.intervals.warmup") },
      { label: L("workout"), detail: workout },
      { label: L("cooldown"), detail: t("plan.steps.intervals.cooldown") },
      stretchStep(),
    ];
  }

  if (type === "TEMPO") {
    const key = km
      ? (paceTxt ? "plan.steps.tempo.workoutKm" : "plan.steps.tempo.workoutKmNoPace")
      : (paceTxt ? "plan.steps.tempo.workoutNoKm" : "plan.steps.tempo.workoutNoKmNoPace");
    return [
      { label: L("warmup"), detail: t("plan.steps.tempo.warmup") },
      { label: L("workout"), detail: t(key, { km, pace: paceTxt }) },
      { label: L("cooldown"), detail: t("plan.steps.tempo.cooldown") },
      stretchStep(),
    ];
  }

  if (type === "LONG") {
    const ratio = runwalkRatio(s, desc);
    const steps: SessionStep[] = [
      { label: L("start"), detail: t("plan.steps.long.start") },
      { label: L("main"), detail: ratio
        ? t("plan.steps.long.mainRatio", ratioTokens(ratio))
        : t(paceTxt ? "plan.steps.long.mainPace" : "plan.steps.long.mainNoPace", { pace: paceTxt }) },
    ];
    if (km >= 15) steps.push({ label: L("fuel"), detail: t("plan.steps.long.fuel") });
    steps.push(stretchStep());
    return steps;
  }

  if (type === "WALK") {
    const ratio = runwalkRatio(s, desc);
    if (ratio) return [
      { label: L("warmup"), detail: t("plan.steps.walk.warmup") },
      { label: L("main"), detail: t("plan.steps.walk.mainRatio", ratioTokens(ratio)) },
      { label: L("cooldown"), detail: t("plan.steps.walk.cooldown") },
      stretchStep(),
    ];
    return [
      { label: L("activity"), detail: t("plan.steps.walk.activity") },
      stretchStep(),
    ];
  }

  if (type === "RACE") {
    return [
      { label: L("before"), detail: t("plan.steps.race.before") },
      { label: L("race"), detail: t(paceTxt ? "plan.steps.race.raceTarget" : "plan.steps.race.raceNoTarget", { pace: paceTxt }) },
      { label: L("after"), detail: t("plan.steps.race.after") },
    ];
  }

  if (type === "OTHER") {
    return [
      { label: L("activity"), detail: t("plan.steps.other") },
      stretchStep(),
    ];
  }

  // EASY and anything unrecognised.
  return [
    { label: L("run"), detail: t(paceTxt ? "plan.steps.easy.runPace" : "plan.steps.easy.runNoPace", { pace: paceTxt }) },
    { label: L("finish"), detail: t("plan.steps.easy.finish") },
  ];
}
