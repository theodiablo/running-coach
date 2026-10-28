import type { Participation, Plan, PlanSession, RecoveryWindow, Run, SettingsState } from "../types";

// Where the runner stands relative to the plan's main race. Derived on every
// read, never stored: the plan is the source of truth, so a rebuild, an undo or
// a restore can't leave a stale phase behind. Date arithmetic is on YYYY-MM-DD
// strings and the clock comes in as `today`, so the core stays free of Date and
// i18n. docs/training-plan.md.
export type PlanPhase = "active" | "raceWeek" | "debrief" | "choosing" | "recovery";

export type MainRace = {
  wNum: number;
  sId: string;
  date: string;
  km: number;
  editionId: string | null;
  session: PlanSession;
};

export type PhaseInfo = {
  phase: PlanPhase;
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

export const RACE_WEEK_DAYS = 7;
export const DEBRIEF_ASK_DAYS = 28;
export const DEBRIEF_RESULT_DAYS = 2;

// Rebuilds carry old weeks under this id prefix (plan.ts): history, not a race to come.
const HISTORY_PREFIX = "past-";

// Days since the epoch for a YYYY-MM-DD, by civil-calendar arithmetic.
function dayNumber(ymd: string): number {
  const [y0, m, d] = ymd.split("-").map(Number);
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe;
}

const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);

// The plan's own RACE session (buildPlan ids it "race"), else the RACE session
// dated plan.raceDate for plans a coach edit reshaped. Onboarding builds without
// mainEditionId, so the edition falls back to the settings' target when they
// name the same date.
export function mainRace(plan: Plan | null | undefined, settings?: Pick<SettingsState, "raceDate" | "targetEditionId">): MainRace | null {
  const raceDate = String(plan?.raceDate || "");
  let byDate: MainRace | null = null;
  for (const w of plan?.weeks || []) {
    for (const s of w.sessions || []) {
      if (s.type !== "RACE" || s.id.startsWith(HISTORY_PREFIX)) continue;
      const hit = { wNum: w.weekNumber, sId: s.id, date: s.date, km: Number(s.km) || 0, session: s,
        editionId: s.editionId ?? (settings && settings.raceDate === s.date ? settings.targetEditionId ?? null : null) };
      if (s.id === "race") return hit;
      if (!byDate && raceDate && s.date === raceDate) byDate = hit;
    }
  }
  return byDate;
}

type PhaseInput = {
  plan: Plan | null | undefined;
  settings: SettingsState;
  participations: Participation[] | null | undefined;
  runs: Run[] | null | undefined;
};

const windowLeft = (w: RecoveryWindow | undefined, today: string): PhaseInfo["recovery"] =>
  w && typeof w.until === "string" && w.until >= today ? { until: w.until, daysLeft: daysBetween(today, w.until) } : null;

export function planPhase({ plan, settings, participations, runs }: PhaseInput, today: string): PhaseInfo | null {
  const race = mainRace(plan, settings);
  if (!race) return null;
  const part = race.editionId ? (participations || []).find(p => p.editionId === race.editionId) : undefined;
  const daysSince = daysBetween(race.date, today);
  const s = race.session;
  // A participation settles it too: detection used to write only that.
  const settled: PhaseInfo["settled"] = s.done ? "done" : s.skipped ? "skipped"
    : part?.status === "done" ? "done" : part?.status === "skipped" ? "skipped" : null;
  const raceRunId = s.runId || part?.runId || null;
  const run = raceRunId ? (runs || []).find(r => r.id === raceRunId) : undefined;
  const resultSec = part?.timeSec ?? run?.durationSec ?? null;
  const base = { race, catalogue: !!race.editionId, daysSince, settled, resultSec, raceRunId };
  const own = windowLeft(plan?.recovery, today);

  if (settled === "skipped") return { ...base, phase: "choosing", recovery: null };
  // A plan opened right after a race carries that race's recovery into its run-up.
  if (daysSince < 0) return { ...base, phase: -daysSince <= RACE_WEEK_DAYS ? "raceWeek" : "active", recovery: windowLeft(plan?.openedAfter, today) };
  if (settled === "done") {
    if (run && run.effort == null && daysSince <= DEBRIEF_RESULT_DAYS)
      return { ...base, phase: "debrief", debrief: "result", recovery: own };
    return own ? { ...base, phase: "recovery", recovery: own } : { ...base, phase: "choosing", recovery: null };
  }
  if (daysSince === 0) return { ...base, phase: "raceWeek", recovery: null };
  return daysSince <= DEBRIEF_ASK_DAYS
    ? { ...base, phase: "debrief", debrief: "ask", recovery: own }
    : { ...base, phase: "choosing", recovery: null };
}
