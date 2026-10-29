// Plans with no race: building them from settings, keeping them going, and
// starting one for a runner who never answered "what's next". Pure; the hub
// (RunningCoach.runPlanAutomation) is the only thing that writes. Detail:
// docs/training-plan.md ("Open plans and blocks").
import { buildPlan, extendOpenPlan, nextMondayYmd, planEndYmd, weeksBetween, type BuildPlanOptions } from "./plan";
import { OPEN_BLOCK_WEEKS } from "./openBlocks";
import { goalKind } from "./recovery";
import { planPhase, type RacePhaseInfo } from "./planPhase";
import { isCrossTraining } from "../types";
import type { GoalKind, OpenTarget, Participation, Plan, Run, SettingsState } from "../types";

// An answerless runner's plan starts this many days after the recovery ends.
export const AUTO_START_DAYS = 3;
// ...but only one who has run since the race (not cross-training, not the race
// itself): a runner who has not run in weeks has not said they want to go on.
export const AUTO_START_NEEDS_RECOVERY_RUN = true;

const plusDays = (ymd: string, n: number) => {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// What a plan with no race is built from.
export type OpenChoice = {
  kind?: Exclude<GoalKind, "race">;
  target: OpenTarget;
  // The distance the target is about (pace reference, long-run scale).
  distanceKm: number;
  // An optional time at that distance ("faster"); else the pace comes from recent runs.
  goalSec?: number | string;
  light?: boolean;
};

type BuildSettings = Pick<SettingsState, "planSessions" | "planStyle" | "trainingLevel" | "runWalkRunSec" | "runWalkWalkSec">;
type BuildCtx = {
  runs: Run[];
  races?: BuildPlanOptions["races"];
  afterRace?: BuildPlanOptions["afterRace"];
  blockOffset?: number;
};

export function buildOpenPlan(settings: BuildSettings, choice: OpenChoice, ctx: BuildCtx): Plan {
  return buildPlan("", choice.goalSec ?? "", settings.planSessions, choice.distanceKm, 0, {
    goal: { kind: choice.kind ?? "open", target: choice.target, light: choice.light },
    recentRuns: ctx.runs, races: ctx.races, mainEditionId: null, style: settings.planStyle,
    level: settings.trainingLevel, runWalk: settings, afterRace: ctx.afterRace,
    blockOffset: ctx.blockOffset,
  }) as unknown as Plan;
}

// The settings an open plan leaves behind. No race date, no race target; the
// distance stays as the pace/long-run reference.
export const openSettingsPatch = (choice: OpenChoice): Partial<SettingsState> => ({
  goalKind: choice.kind ?? "open", openTarget: choice.target, lightPlan: !!choice.light,
  raceDate: "", targetEditionId: null, distanceKm: choice.distanceKm, goalSec: choice.goalSec ?? "",
});

// Whether an open plan's last block has started, so the next one is due. The
// plan's own end is the idempotence: an extended plan ends a block or more
// further on, so a second call (or a second device that has synced the
// extension) finds nothing due. `extendedThrough` only records how far it went.
export function extensionDue(plan: Plan | null | undefined, today: string): boolean {
  if (!plan || goalKind(plan) === "race") return false;
  const end = planEndYmd(plan);
  return !!end && today >= plusDays(end, -OPEN_BLOCK_WEEKS * 7);
}

// The plan with its next blocks appended, or null when there is nothing to add.
export function extendedOpenPlan(
  plan: Plan, settings: BuildSettings & Pick<SettingsState, "goalSec">, runs: Run[],
  races: BuildPlanOptions["races"], today: string,
): Plan | null {
  const g = plan.goal;
  if (!g || goalKind(plan) === "race") return null;
  const start = g.startDate || plan.weeks[0]?.startDate;
  if (!start) return null;
  const kind = goalKind(plan) as Exclude<GoalKind, "race">;
  const target: OpenTarget = g.target === "faster" || g.target === "further" ? g.target : "healthy";
  const built = buildOpenPlan(settings, {
    kind, target, light: !!g.light, distanceKm: Number(g.distanceKm) || Number(plan.distanceKm) || 10,
    goalSec: g.paceSource === "goal" ? settings.goalSec : "",
  }, { runs, races, blockOffset: Math.max(0, weeksBetween(start, nextMondayYmd(new Date(today + "T12:00:00")))) });
  const next = extendOpenPlan(plan, built);
  return next === plan ? null : next;
}

// The identity of a main race, which "answered" is recorded against.
export const raceKey = (race: { editionId: string | null; date: string }) => (race.editionId || "") + "@" + race.date;

export type AutoStart = { key: string; info: RacePhaseInfo; hadRuns: boolean };

type AutoInput = {
  plan: Plan | null | undefined;
  settings: SettingsState;
  participations: Participation[] | null | undefined;
  runs: Run[] | null | undefined;
};

// A runner whose race is long over and who never answered "what's next": a
// gentle plan at their recent volume, started AUTO_START_DAYS after the
// recovery ended. A plan written before recovery existed has no `until`, so it
// can never start itself.
export function autoStartDue(input: AutoInput, today: string): AutoStart | null {
  const info = planPhase(input, today);
  if (!info || info.phase !== "choosing" || !input.plan) return null;
  const until = input.plan.recovery?.until;
  if (!until || today < plusDays(until, AUTO_START_DAYS)) return null;
  const key = raceKey(info.race);
  if (input.settings.whatsNextFor === key || input.plan.goal?.autoFor === key) return null;
  const hadRuns = (input.runs || []).some(r => !isCrossTraining(r) && r.id !== info.raceRunId
    && String(r.type).toUpperCase() !== "RACE" && r.date > info.race.date && r.date <= until && (Number(r.km) || 0) > 0);
  if (AUTO_START_NEEDS_RECOVERY_RUN && !hadRuns) return null;
  return { key, info, hadRuns };
}
