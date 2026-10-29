// @ts-expect-error Shared Deno/Vitest ESM has no TypeScript declaration file.
import * as sharedPhase from "../../supabase/functions/_shared/coach/phase.mjs";
import type { GoalKind, OpenTarget, Participation, Plan, PlanSession, Run, SettingsState } from "../types";

// Where the runner stands relative to the plan's main race. Derived on every
// read, never stored: the plan is the source of truth, so a rebuild, an undo or
// a restore can't leave a stale phase behind. The core is shared with the coach
// (supabase/functions/_shared/coach/phase.mjs: YYYY-MM-DD strings, the clock as
// `today`, no Date or i18n); this file types it. docs/training-plan.md.
export type PlanPhase = "active" | "raceWeek" | "debrief" | "choosing" | "recovery" | "open";

export type MainRace = {
  wNum: number;
  sId: string;
  date: string;
  km: number;
  editionId: string | null;
  session: PlanSession;
};

export type RacePhaseInfo = {
  phase: Exclude<PlanPhase, "open">;
  race: MainRace;
  catalogue: boolean;
  // Whole days since the race; negative before it.
  daysSince: number;
  settled: "done" | "skipped" | null;
  debrief?: "ask" | "result";
  // The easy-only window still ahead (or running), whatever the phase: only a
  // plan written with a recovery has one. daysLeft is 0 on its last day.
  recovery: { until: string; daysLeft: number } | null;
  resultSec: number | null;
  raceRunId: string | null;
};

// A plan with no race ("block" for a fitness runner's own blocks, "open" for
// Keep improving): no race to stand relative to, so the block is the unit.
export type OpenPhaseInfo = {
  phase: "open";
  race: null;
  kind: Exclude<GoalKind, "race">;
  target: OpenTarget;
  light: boolean;
  // 1-based block the runner is in (1 before the plan starts).
  block: number;
  // The next checkpoint run still to do, null when none is left.
  checkpoint: string | null;
  recovery: { until: string; daysLeft: number } | null;
  // The race-only fields, absent here, so race-plan readers narrow on them.
  catalogue?: undefined;
  daysSince?: undefined;
  settled?: undefined;
  debrief?: undefined;
  resultSec?: undefined;
  raceRunId?: undefined;
};

export type PhaseInfo = RacePhaseInfo | OpenPhaseInfo;

export type PhaseInput = {
  plan: Plan | null | undefined;
  settings: SettingsState;
  participations: Participation[] | null | undefined;
  runs: Run[] | null | undefined;
};

type PhaseExports = {
  RACE_WEEK_DAYS: number;
  DEBRIEF_ASK_DAYS: number;
  DEBRIEF_RESULT_DAYS: number;
  mainRace: (plan: Plan | null | undefined, settings?: Pick<SettingsState, "raceDate" | "targetEditionId">) => MainRace | null;
  planPhase: (input: PhaseInput, today: string) => PhaseInfo | null;
};

export const { RACE_WEEK_DAYS, DEBRIEF_ASK_DAYS, DEBRIEF_RESULT_DAYS, mainRace, planPhase } = sharedPhase as PhaseExports;
