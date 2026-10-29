// Recovery after the race. The rules and the one date rule live with the edge
// function (supabase/functions/_shared/coach/recovery.mjs) so the validator, the
// runner's plan edits and the coach's tools can never disagree about which days
// may hold training; this is the typed app-side re-export, plus the one
// app-only piece: noticing a race the runner just ran. docs/training-plan.md.
// @ts-expect-error Shared Deno/Vitest ESM has no TypeScript declaration file.
import * as sharedRecovery from "../../supabase/functions/_shared/coach/recovery.mjs";
import { planPhase } from "./planPhase";
import type { Participation, Plan, Run, SettingsState } from "../types";

export type RecoveryRule = { maxKm: number; days: number; rest: number };

type RecoveryExports = {
  RECOVERY_RULES: RecoveryRule[];
  FIRST_WEEK_BACK_KM: number;
  recoveryRule: (km: unknown) => RecoveryRule;
  goalKind: (plan: Plan | null | undefined) => "race" | "block" | "open";
  inRecovery: (plan: Plan | null | undefined, date: string) => boolean;
  canHoldTraining: (plan: Plan | null | undefined, date: string, settled?: boolean) => boolean;
};

export const { RECOVERY_RULES, FIRST_WEEK_BACK_KM, recoveryRule, goalKind, inRecovery, canHoldTraining } =
  sharedRecovery as RecoveryExports;

// A new plan opens "after a race" when one was run this recently.
export const RECENT_RACE_DAYS = 14;
const MIN_RACE_RUN_KM = 3;

const shift = (ymd: string, n: number) => {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

type RecentRaceInput = {
  plan: Plan | null | undefined;
  participations: Participation[] | null | undefined;
  runs: Run[] | null | undefined;
  settings: SettingsState;
};

// The latest race the runner finished in the two weeks before `today`: the plan's
// main race once settled, a done participation, or a run logged as a race.
export function recentRace(input: RecentRaceInput, today: string): { date: string; km: number } | null {
  const from = shift(today, -RECENT_RACE_DAYS);
  const found: { date: string; km: number }[] = [];
  const info = planPhase(input, today);
  if (info?.settled === "done") found.push({ date: info.race.date, km: info.race.km });
  for (const p of input.participations || [])
    if (p.status === "done" && p.raceDate && Number(p.distanceKm) > 0) found.push({ date: p.raceDate, km: Number(p.distanceKm) });
  for (const r of input.runs || [])
    if (String(r.type).toUpperCase() === "RACE" && r.km >= MIN_RACE_RUN_KM) found.push({ date: r.date, km: r.km });
  return found.filter(r => r.date >= from && r.date < today && r.km > 0)
    .sort((a, b) => b.date.localeCompare(a.date) || b.km - a.km)[0] ?? null;
}
