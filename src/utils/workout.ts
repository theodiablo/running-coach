// Guided workout compilation + live step engine (premium; docs/guided-workouts.md).
//
// compileWorkout turns a plan session into a machine-readable step schedule —
// the guided counterpart of sessionSteps' prose, built from the same sd-first /
// desc-fallback sources so the two can never disagree on the figures. The
// engine (advanceWorkout) is a pure reducer over the tracker's cumulative
// {km, movingSec}: it is driven by the accepted-GPS-fix render path and the
// foreground 1s tick, NEVER a timer of its own — background JS timers are
// frozen exactly when a run is being recorded (CLAUDE.md). i18n-free: callers
// render step/cue copy themselves.

import { parseRepsRaw, parseRatio } from "./sessionSteps";
import type { SessionSd } from "../types";

export type WorkoutStepKind = "warmup" | "work" | "recover" | "run" | "walk" | "cooldown";

// Exactly one bound per step: distance (`m`) or moving time (`sec`).
export type WorkoutStep = {
  kind: WorkoutStepKind;
  m?: number;
  sec?: number;
  /** Target pace (sec/km) — work steps only; warmup/recovery are unguided. */
  pace?: number;
  /** ± tolerance (sec/km) around `pace` for the live verdict. */
  band?: number;
  /** 1-based rep position, for "Rep 3 of 6" display/announcements. */
  rep?: number;
  reps?: number;
};

export type Workout = {
  steps: WorkoutStep[];
  /** Run/walk sessions cycle: past the last step, wrap back to this index. */
  loopFrom?: number;
};

// Guided figures inside the ranges the "how it unfolds" prose promises
// (plan.steps.*: warm-up "10–15 min", cool-down "5–10 min") — pinned by tests.
export const WARMUP_SEC = 720;
export const COOLDOWN_SEC = 480;
export const WALK_WARMUP_SEC = 300; // walk sessions: "5 min of brisk walking"
// Verdict tolerance around the target pace. Reps get more slack than a tempo
// block: the 30s current-pace window is noisy over an 800m effort.
export const TEMPO_BAND_SEC_PER_KM = 12;
export const REP_BAND_SEC_PER_KM = 15;
// "jogs" and unparseable recoveries: a generic easy jog between reps.
export const RECOVER_DEFAULT_SEC = 120;

type SessionLike = {
  type?: string;
  desc?: string;
  km?: number | string;
  pace?: number | string | null;
  sd?: SessionSd;
};

// Recovery step from the sd token, else parsed from the canonical English desc.
const recoverStep = (sd: SessionSd | undefined, desc: string): WorkoutStep => {
  const tok = sd?.kind === "intervals" ? sd.recover : undefined;
  if (tok === "90s" || tok === "90sJog") return { kind: "recover", sec: 90 };
  if (tok === "1kmJog") return { kind: "recover", m: 1000 };
  if (tok === "jogs") return { kind: "recover", sec: RECOVER_DEFAULT_SEC };
  // Adjacent only ("90s recovery", "90s jog recovery") — a loose span would
  // swallow Hansons' "goal pace minus 10s … + 1km jog recovery".
  const m = desc.match(/(\d+)\s*s\s*(?:jog\s*)?recover/i);
  if (m) return { kind: "recover", sec: Number(m[1]) };
  if (/1\s*km\s*(jog\s*)?recover/i.test(desc)) return { kind: "recover", m: 1000 };
  return { kind: "recover", sec: RECOVER_DEFAULT_SEC };
};

const repsFor = (s: SessionLike, desc: string): { count: number; m: number } | null => {
  if (s.sd?.kind === "intervals" && s.sd.reps && s.sd.repM)
    return { count: s.sd.reps, m: s.sd.repM };
  return parseRepsRaw(desc);
};

const ratioFor = (s: SessionLike, desc: string): { run: number; walk: number } | null => {
  if (s.sd?.kind === "runwalk" && s.sd.runMin != null && s.sd.walkMin != null)
    return { run: s.sd.runMin, walk: s.sd.walkMin };
  return parseRatio(desc);
};

/**
 * Compile a plan session into a guided step schedule, or null when the session
 * has no structure to guide (easy/long/race/cross days, or a rep/tempo session
 * missing its figures). Warm-up/recovery/cool-down steps carry no pace target:
 * the session row doesn't know the runner's easy pace, and "easy" is the
 * honest instruction.
 */
export function compileWorkout(s: SessionLike): Workout | null {
  const type = String(s.type || "");
  const desc = String(s.desc || "");
  const pace = Number(s.pace) || 0;

  if (type === "INTERVALS") {
    const reps = repsFor(s, desc);
    if (!reps || reps.count < 1 || reps.m <= 0) return null;
    const steps: WorkoutStep[] = [{ kind: "warmup", sec: WARMUP_SEC }];
    for (let i = 1; i <= reps.count; i++) {
      steps.push({
        kind: "work", m: reps.m, rep: i, reps: reps.count,
        ...(pace > 0 ? { pace, band: REP_BAND_SEC_PER_KM } : {}),
      });
      if (i < reps.count) steps.push(recoverStep(s.sd, desc));
    }
    steps.push({ kind: "cooldown", sec: COOLDOWN_SEC });
    return { steps };
  }

  if (type === "TEMPO") {
    // A tempo row's km IS the work block (warm-up/cool-down ride on top) —
    // see buildPlan's tempo sessions, unlike interval rows' whole-outing km.
    const km = Number(s.km) || 0;
    if (km <= 0) return null;
    return {
      steps: [
        { kind: "warmup", sec: WARMUP_SEC },
        { kind: "work", m: Math.round(km * 1000), ...(pace > 0 ? { pace, band: TEMPO_BAND_SEC_PER_KM } : {}) },
        { kind: "cooldown", sec: COOLDOWN_SEC },
      ],
    };
  }

  if (type === "WALK" || type === "LONG") {
    const ratio = ratioFor(s, desc);
    if (!ratio || ratio.run <= 0 || ratio.walk <= 0) return null;
    const cycle: WorkoutStep[] = [
      { kind: "run", sec: ratio.run * 60 },
      { kind: "walk", sec: ratio.walk * 60 },
    ];
    // Walk sessions warm up first ("5 min of brisk walking"); a run/walk long
    // run settles straight into the ratio.
    if (type === "WALK") return { steps: [{ kind: "warmup", sec: WALK_WARMUP_SEC }, ...cycle], loopFrom: 1 };
    return { steps: cycle, loopFrom: 0 };
  }

  return null;
}

// ── live engine ────────────────────────────────────────────────────────────

export type WorkoutProgress = {
  /** Monotonic step counter — index into the unrolled schedule (loops wrap). */
  idx: number;
  /** Cumulative km / moving sec at the moment the current step began. */
  stepStartKm: number;
  stepStartSec: number;
  done: boolean;
};

export const initialWorkoutProgress: WorkoutProgress = { idx: 0, stepStartKm: 0, stepStartSec: 0, done: false };

/** The step a monotonic index addresses, wrapping through the loop if any. */
export function stepAt(w: Workout, idx: number): WorkoutStep | null {
  if (idx < w.steps.length) return w.steps[idx];
  if (w.loopFrom == null || w.loopFrom >= w.steps.length) return null;
  const cycle = w.steps.length - w.loopFrom;
  return w.steps[w.loopFrom + ((idx - w.loopFrom) % cycle)];
}

const stepCrossed = (step: WorkoutStep, p: WorkoutProgress, km: number, movingSec: number): boolean => {
  if (step.m != null) return (km - p.stepStartKm) * 1000 >= step.m - 1e-6;
  if (step.sec != null) return movingSec - p.stepStartSec >= step.sec;
  return false;
};

/**
 * Advance through every step boundary the tracker's cumulative {km, movingSec}
 * has crossed since the last call. Multiple boundaries can fall in one call
 * (screen-on catch-up after a background stretch); `entered` lists each newly
 * entered step index in order so the caller can cue the LAST one and count the
 * rest as passed. Pure — never mutates its inputs.
 */
export function advanceWorkout(
  w: Workout,
  p: WorkoutProgress,
  now: { km: number; movingSec: number },
): { progress: WorkoutProgress; entered: number[]; finished: boolean } {
  let cur = p;
  const entered: number[] = [];
  let finished = false;
  for (;;) {
    if (cur.done) break;
    const step = stepAt(w, cur.idx);
    if (!step || !stepCrossed(step, cur, now.km, now.movingSec)) break;
    // Boundaries advance by the step's own bound (not to "now"), so a
    // several-steps catch-up attributes each step its true start point.
    const startKm = step.m != null ? cur.stepStartKm + step.m / 1000 : now.km;
    const startSec = step.sec != null ? cur.stepStartSec + step.sec : now.movingSec;
    const next: WorkoutProgress = { idx: cur.idx + 1, stepStartKm: startKm, stepStartSec: startSec, done: false };
    if (stepAt(w, next.idx) == null) {
      cur = { ...next, done: true };
      finished = true;
      break;
    }
    entered.push(next.idx);
    cur = next;
  }
  return { progress: cur, entered, finished };
}

/** Remaining distance (m) or moving time (sec) in the current step. */
export function stepRemaining(
  step: WorkoutStep,
  p: WorkoutProgress,
  now: { km: number; movingSec: number },
): { m?: number; sec?: number } {
  if (step.m != null) return { m: Math.max(0, Math.round(step.m - (now.km - p.stepStartKm) * 1000)) };
  if (step.sec != null) return { sec: Math.max(0, Math.ceil(step.sec - (now.movingSec - p.stepStartSec))) };
  return {};
}

export type PaceVerdict = "slow" | "on" | "fast";

/** Live pace vs the step's band; null when the step has no target or no pace yet. */
export function paceVerdict(step: WorkoutStep, curPaceSecPerKm: number): PaceVerdict | null {
  if (!step.pace || !step.band || !(curPaceSecPerKm > 0)) return null;
  if (curPaceSecPerKm > step.pace + step.band) return "slow";
  if (curPaceSecPerKm < step.pace - step.band) return "fast";
  return "on";
}
