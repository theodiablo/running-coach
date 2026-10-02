// The runner-editable description of today's run (docs/guided-workouts.md):
// what the recorder's "Today's run" card shows and its sheet edits. A plan
// session seeds it via specFromSession (built on compileWorkout, so the guided
// figures still come from the one parser shared with the prose); compileSpec
// turns it back into the step schedule the engine runs. Edits apply to the
// current recording only — the plan is never written.

import { COOLDOWN_SEC, WARMUP_SEC, compileWorkout, type Workout, type WorkoutStep } from "./workout";
import { HR_ZONES, SESSION_ZONES, effectiveMaxHR, hrZoneBpm } from "./hr";
import type { SettingsState } from "../types";

export type WorkoutType = "regular" | "tempo" | "intervals" | "runwalk";
export type WorkoutGoal = "open" | "km" | "time";

export type WorkoutSpec = {
  type: WorkoutType;
  /** Regular runs only: an optional distance or duration. */
  goal: WorkoutGoal;
  goalKm: number;
  goalMin: number;
  /** Target pace (sec/km) for the work part; null = no pace target. */
  pace: number | null;
  /** 1-based HR zone span (inclusive); null = no heart-rate target. */
  hrZone: [number, number] | null;
  warmMin: number;
  coolMin: number;
  blockUnit: "km" | "min";
  blockKm: number;
  blockMin: number;
  reps: number;
  repUnit: "m" | "sec";
  repM: number;
  repSec: number;
  recUnit: "sec" | "m";
  recSec: number;
  recM: number;
  runSec: number;
  walkSec: number;
};

export const DEFAULT_SPEC: WorkoutSpec = {
  type: "regular", goal: "open", goalKm: 5, goalMin: 30, pace: null, hrZone: null,
  warmMin: WARMUP_SEC / 60, coolMin: COOLDOWN_SEC / 60,
  blockUnit: "km", blockKm: 5, blockMin: 20,
  reps: 6, repUnit: "m", repM: 800, repSec: 180,
  recUnit: "sec", recSec: 90, recM: 400,
  runSec: 120, walkSec: 60,
};

export const WORKOUT_TYPES: WorkoutType[] = ["regular", "tempo", "intervals", "runwalk"];

type NumField = "pace" | "warmMin" | "coolMin" | "blockKm" | "blockMin" | "reps" | "repM" | "repSec"
  | "recSec" | "recM" | "runSec" | "walkSec" | "goalKm" | "goalMin";

/** [step, min, max] per numeric field — the sheet's steppers and readSpec's clamp. */
export const SPEC_LIMITS: Record<NumField, [step: number, min: number, max: number]> = {
  pace: [5, 150, 600], warmMin: [1, 0, 30], coolMin: [1, 0, 30],
  blockKm: [0.5, 0.5, 42], blockMin: [5, 5, 120], reps: [1, 1, 30],
  repM: [100, 100, 5000], repSec: [15, 15, 1200], recSec: [15, 15, 600], recM: [100, 100, 2000],
  runSec: [15, 15, 1200], walkSec: [15, 15, 600], goalKm: [0.5, 0.5, 100], goalMin: [5, 5, 360],
};

/** Nothing to guide: no structure, no goal, no target. */
export const isOpenSpec = (s: WorkoutSpec) =>
  s.type === "regular" && s.goal === "open" && s.pace == null && s.hrZone == null;

/** Plan session types that start with audio guidance on. */
export const specWantsAudio = (s: WorkoutSpec) => s.type !== "regular";

type SessionLike = Parameters<typeof compileWorkout>[0];

const zoneSpan = (type: string): [number, number] | null => {
  const cfg = (SESSION_ZONES as Record<string, { zones: number[] }>)[type];
  return cfg ? [cfg.zones[0], cfg.zones[cfg.zones.length - 1]] : null;
};

/** Today's run as the plan session describes it. */
export function specFromSession(s: SessionLike): WorkoutSpec {
  const type = String(s.type || "");
  const pace = Number(s.pace) > 0 ? Number(s.pace) : null;
  // Race day runs above its zone by design; warning about it would only nag.
  const hrZone = type === "RACE" ? null : zoneSpan(type);
  const w = compileWorkout(s);
  const base: WorkoutSpec = { ...DEFAULT_SPEC, pace, hrZone };
  if (!w) {
    const km = Number(s.km) || 0;
    return km > 0 ? { ...base, goal: "km", goalKm: km } : base;
  }
  if (w.loopFrom != null) {
    const run = w.steps.find(x => x.kind === "run");
    const walk = w.steps.find(x => x.kind === "walk");
    const warm = w.steps[0].kind === "warmup" ? (w.steps[0].sec || 0) / 60 : 0;
    return { ...base, type: "runwalk", pace: null, warmMin: warm, coolMin: 0,
      runSec: run?.sec || DEFAULT_SPEC.runSec, walkSec: walk?.sec || DEFAULT_SPEC.walkSec };
  }
  const warm = w.steps.find(x => x.kind === "warmup");
  const cool = w.steps.find(x => x.kind === "cooldown");
  const timing = { warmMin: (warm?.sec || 0) / 60, coolMin: (cool?.sec || 0) / 60 };
  const works = w.steps.filter(x => x.kind === "work");
  if (type === "TEMPO") return { ...base, ...timing, type: "tempo", blockUnit: "km", blockKm: (works[0].m || 0) / 1000 };
  const rec = w.steps.find(x => x.kind === "recover");
  return {
    ...base, ...timing, type: "intervals", reps: works.length, repUnit: "m", repM: works[0].m || DEFAULT_SPEC.repM,
    ...(rec?.m != null ? { recUnit: "m" as const, recM: rec.m } : { recUnit: "sec" as const, recSec: rec?.sec ?? DEFAULT_SPEC.recSec }),
  };
}

/** Bpm bounds for a zone span on this runner's profile, or null when unknown. */
export function zoneBpm(
  zone: [number, number] | null,
  profile: Partial<Pick<SettingsState, "maxHR" | "restHR" | "birthYear" | "age">>,
): { lo: number; hi: number } | null {
  if (!zone) return null;
  const lo = HR_ZONES[zone[0] - 1], hi = HR_ZONES[zone[1] - 1];
  if (!lo || !hi) return null;
  return hrZoneBpm(lo.lo, hi.hi, effectiveMaxHR(profile), profile.restHR || 60);
}

/**
 * The step schedule for a spec. `band` is the runner's pace leeway; `hr` the
 * zone's bpm bounds (targets ride work steps only — warm-up and recovery are
 * "easy", which the session can't put a number on).
 */
export function compileSpec(s: WorkoutSpec, opts: { band: number; hr?: { lo: number; hi: number } | null }): Workout {
  const hrTarget = opts.hr ? { hrLo: opts.hr.lo, hrHi: opts.hr.hi } : {};
  const target = { ...(s.pace ? { pace: s.pace, band: opts.band } : {}), ...hrTarget };
  const warm: WorkoutStep[] = s.warmMin > 0 ? [{ kind: "warmup", sec: Math.round(s.warmMin * 60) }] : [];
  const cool: WorkoutStep[] = s.coolMin > 0 ? [{ kind: "cooldown", sec: Math.round(s.coolMin * 60) }] : [];
  if (s.type === "tempo") {
    const bound = s.blockUnit === "km" ? { m: Math.round(s.blockKm * 1000) } : { sec: Math.round(s.blockMin * 60) };
    return { steps: [...warm, { kind: "work", ...bound, ...target }, ...cool] };
  }
  if (s.type === "intervals") {
    const steps: WorkoutStep[] = [...warm];
    for (let i = 1; i <= s.reps; i++) {
      steps.push({ kind: "work", ...(s.repUnit === "m" ? { m: s.repM } : { sec: s.repSec }), rep: i, reps: s.reps, ...target });
      if (i < s.reps) steps.push({ kind: "recover", ...(s.recUnit === "m" ? { m: s.recM } : { sec: s.recSec }) });
    }
    return { steps: [...steps, ...cool] };
  }
  if (s.type === "runwalk") {
    // No HR target on run/walk: the walk breaks are what keep it in zone.
    return { steps: [...warm, { kind: "run", sec: s.runSec }, { kind: "walk", sec: s.walkSec }], loopFrom: warm.length };
  }
  const bound = s.goal === "km" ? { m: Math.round(s.goalKm * 1000) } : s.goal === "time" ? { sec: Math.round(s.goalMin * 60) } : {};
  return { steps: [{ kind: "steady", ...bound, ...target }] };
}

/** Rough share of the session each step takes, for the card's timeline bar. */
export function stepWeights(w: Workout, pace: number | null): number[] {
  const p = pace || 330;
  return w.steps.map(st => st.sec != null ? st.sec : st.m != null ? (st.m / 1000) * (st.kind === "work" || st.kind === "steady" ? p : p + 60) : 1);
}

/** Sanitized read of a stored spec (settings.freeWorkout); unknown or malformed fields fall back. */
export function readSpec(raw: unknown): WorkoutSpec {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: WorkoutSpec = { ...DEFAULT_SPEC };
  // Clamped to what the sheet can produce: a synced blob is user-writable, and
  // a zero-length loop or a billion reps would hang the engine.
  const num = (k: Exclude<NumField, "pace">) => {
    const v = r[k];
    const [, min, max] = SPEC_LIMITS[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.min(max, Math.max(min, k === "reps" ? Math.round(v) : v));
  };
  (["goalKm", "goalMin", "warmMin", "coolMin", "blockKm", "blockMin", "reps", "repM", "repSec", "recSec", "recM", "runSec", "walkSec"] as const).forEach(num);
  if (WORKOUT_TYPES.includes(r.type as WorkoutType)) out.type = r.type as WorkoutType;
  if (r.goal === "open" || r.goal === "km" || r.goal === "time") out.goal = r.goal;
  if (r.blockUnit === "km" || r.blockUnit === "min") out.blockUnit = r.blockUnit;
  if (r.repUnit === "m" || r.repUnit === "sec") out.repUnit = r.repUnit;
  if (r.recUnit === "m" || r.recUnit === "sec") out.recUnit = r.recUnit;
  out.pace = typeof r.pace === "number" && Number.isFinite(r.pace) && r.pace > 0
    ? Math.min(SPEC_LIMITS.pace[2], Math.max(SPEC_LIMITS.pace[1], r.pace)) : null;
  const z = r.hrZone;
  out.hrZone = Array.isArray(z) && z.length === 2 && z.every(n => Number.isInteger(n) && n >= 1 && n <= 5) && z[0] <= z[1]
    ? [z[0], z[1]] : null;
  return out;
}
