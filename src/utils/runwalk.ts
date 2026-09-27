// The Run/Walk style's ratio: what the runner can actually hold, and how the
// plan ramps to it. Pure, no i18n — the one place the ratio ladder is defined,
// read by buildPlan (the plan author) and by the picker under the Run/Walk
// style card. docs/training-plan.md.

export type RunWalkConfig = { runSec: number; walkSec: number };

// 3 min / 1 min — the ceiling the pre-setting plan always ramped to.
export const RUNWALK_DEFAULT: RunWalkConfig = { runSec: 180, walkSec: 60 };

// Offered in the picker. The run column is a ceiling, not a starting point.
export const RUNWALK_RUN_OPTIONS = [30, 45, 60, 90, 120, 180, 240];
export const RUNWALK_WALK_OPTIONS = [30, 45, 60, 90, 120];

const RUN_MIN = 20, RUN_MAX = 600, WALK_MIN = 15, WALK_MAX = 300;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// The stored settings pair, defaulted and clamped — it rides the user-writable
// blob, so a nonsense figure must never reach the plan.
export function runWalkConfig(s: { runWalkRunSec?: number; runWalkWalkSec?: number } | null | undefined): RunWalkConfig {
  const run = Number(s?.runWalkRunSec), walk = Number(s?.runWalkWalkSec);
  return {
    runSec: Number.isFinite(run) && run > 0 ? Math.round(clamp(run, RUN_MIN, RUN_MAX) / 5) * 5 : RUNWALK_DEFAULT.runSec,
    walkSec: Number.isFinite(walk) && walk > 0 ? Math.round(clamp(walk, WALK_MIN, WALK_MAX) / 5) * 5 : RUNWALK_DEFAULT.walkSec,
  };
}

// This week's run interval. The ceiling is the runner's own answer to "how long
// can you run for", so the ramp is expressed as thirds OF IT and PEAK is the
// ceiling exactly — never past it, and never below 30 s. With the 180 s default
// this is the original fixed 1 / 2 / 2 / 3 min ladder, to the second. The taper
// steps back down with BUILD: its job is shedding fatigue, not setting a record.
export function runwalkRunSec(cfg: RunWalkConfig, phase: string): number {
  const frac = phase === "BASE" ? 1 / 3 : phase === "PEAK" ? 1 : 2 / 3;
  const step = Math.round((cfg.runSec * frac) / 15) * 15;
  return Math.min(cfg.runSec, Math.max(Math.min(30, cfg.runSec), step));
}
