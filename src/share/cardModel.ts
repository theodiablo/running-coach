// What each share card style shows, and which style the builder pre-selects.
// Pure: strings are i18n keys + vars, figures go through fmt. docs/share-card.md.
import { rankRunEfforts, isPersonalBest, isFirstEffort } from "../utils/bestEfforts";
import type { EffortRank } from "../utils/bestEfforts";
import { planPhase, mainRace } from "../utils/planPhase";
import { fmt, addDays } from "../utils/format";
import { isCrossTraining } from "../types";
import type { Participation, Plan, PlanSession, PlanWeek, Run, SettingsState } from "../types";

export type CardStyle = "route" | "number" | "week";
export type Line = { key: string; vars?: Record<string, string | number> };
export type Stat = { label: Line; value: string; unit?: string };

export type CardInput = {
  run: Run;
  runs: Run[];
  plan: Plan | null | undefined;
  settings: SettingsState;
  participations: Participation[] | null | undefined;
  today: string;
  // The finish screen's run isn't linked yet: the session the recorder was opened from.
  session?: PlanSession | null;
  // Whether routeShape found a line worth drawing with the mask on.
  hasRoute: boolean;
  raceLabel?: string | null;
};

const HEAD_RUN = 6;
const HEAD_PB = 3;

// A stable pick per run, so reopening the builder doesn't reshuffle the line.
function pick(seed: string, n: number) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return (h % n) + 1;
}

const isIndoor = (run: Run) => isCrossTraining(run) || !(Number(run.km) > 0);

export function settledSession(plan: Plan | null | undefined, run: Run): PlanSession | null {
  if (!plan?.weeks || !run.id) return null;
  for (const w of plan.weeks) for (const s of w.sessions) if (s.runId === run.id && s.done) return s;
  return null;
}

const byLongest = (a: EffortRank, b: EffortRank) => b.km - a.km;

export function headlineEffort(run: Run, runs: Run[]): { effort: EffortRank; kind: "pb" | "first" } | null {
  // An estimate from average pace is no claim to put on a public card.
  const efforts = isIndoor(run) ? [] : rankRunEfforts(run, runs).filter(e => !e.estimated);
  const pb = efforts.filter(isPersonalBest).sort(byLongest)[0];
  if (pb) return { effort: pb, kind: "pb" };
  const first = efforts.filter(isFirstEffort).sort(byLongest)[0];
  return first ? { effort: first, kind: "first" } : null;
}

function currentWeek(plan: Plan, today: string): PlanWeek | null {
  return plan.weeks.find(w => !!w.startDate && w.startDate <= today && today <= addDays(w.startDate, 6)) ?? null;
}

// Week is only true to this week: an older run would sit next to this week's sessions.
export function weekAvailable(input: CardInput): boolean {
  return !!weekModel(input);
}

export function cardStyles(input: CardInput): { offered: CardStyle[]; preselected: CardStyle } {
  const week = weekAvailable(input);
  const offered: CardStyle[] = [...(input.hasRoute ? ["route" as const] : []), "number", ...(week ? ["week" as const] : [])];
  const pb = headlineEffort(input.run, input.runs)?.kind === "pb";
  const settled = !!(input.session || settledSession(input.plan, input.run));
  const preselected: CardStyle = pb ? "number" : settled && week ? "week" : input.hasRoute ? "route" : "number";
  return { offered, preselected };
}

export function statsFor(run: Run, showPace: boolean): Stat[] {
  const time: Stat = { label: { key: "shareCard.stat.time" }, value: fmt.dur(run.durationSec) };
  if (isIndoor(run)) {
    return run.hr ? [time, { label: { key: "shareCard.stat.hr" }, value: String(run.hr), unit: "bpm" }] : [time];
  }
  const out: Stat[] = [{ label: { key: "shareCard.stat.distance" }, value: fmt.km(run.km), unit: "km" }, time];
  if (showPace && run.durationSec) out.push({ label: { key: "shareCard.stat.pace" }, value: fmt.pace(run.durationSec / Number(run.km)), unit: "/km" });
  return out;
}

export type RouteModel = { headline: Line; pill: { dist: string; time: string } | null; stats: Stat[] };

export function routeModel(input: CardInput, showPace: boolean): RouteModel {
  const { run, runs } = input;
  const best = headlineEffort(run, runs);
  const pb = best?.kind === "pb" ? best.effort : null;
  const seed = String(run.id || run.date);
  return {
    headline: pb ? { key: `shareCard.head.pb.p${pick(seed, HEAD_PB)}` } : { key: `shareCard.head.run.r${pick(seed, HEAD_RUN)}` },
    pill: pb ? { dist: `bestEfforts.dist.${pb.key}`, time: fmt.dur(pb.sec) } : null,
    stats: statsFor(run, showPace),
  };
}

export type NumberModel = {
  tag: Line | null;
  label: Line | null;
  figure: string;
  unit?: string;
  context: Line | null;
  stats: Stat[];
};

export function numberModel(input: CardInput, showPace: boolean): NumberModel {
  const { run, runs } = input;
  const stats = statsFor(run, showPace);
  const best = headlineEffort(run, runs);
  if (best) {
    const e = best.effort;
    const gain = best.kind === "pb" && e.gainSec && e.gainSec > 0 ? e.gainSec : null;
    return {
      tag: { key: best.kind === "pb" ? "shareCard.number.tagPb" : "shareCard.number.tagFirst" },
      label: { key: `bestEfforts.dist.${e.key}` },
      figure: fmt.dur(e.sec),
      context: gain ? { key: "shareCard.number.faster", vars: { delta: gain < 60 ? `${gain} s` : fmt.dur(gain) } } : null,
      stats,
    };
  }
  if (isIndoor(run)) {
    const act = typeof run.activity === "string" ? run.activity : "other";
    return { tag: null, label: { key: `shareCard.activity.${act}` }, figure: fmt.dur(run.durationSec), context: null, stats };
  }
  return { tag: null, label: null, figure: fmt.km(run.km), unit: "km", context: null, stats };
}

export type DayState = "done" | "open" | "rest";
export type WeekDay = { date: string; state: DayState; isRunDay: boolean };

export type WeekModel = {
  header: { kind: "race"; title: string | null; daysToGo: number } | { kind: "block"; block: number };
  weekN: number;
  weekM: number;
  phase: Line | null;
  days: WeekDay[];
  done: number;
  planned: number;
  weekKm: number;
  // "Today" when the run is today, else its weekday (0 = Monday).
  runDay: { today: true } | { today: false; weekday: number };
  runType: Line;
  stats: Stat[];
};

export function weekModel(input: CardInput, showPace = true): WeekModel | null {
  const { plan, run, today } = input;
  if (!plan?.weeks?.length) return null;
  const info = planPhase({ plan, settings: input.settings, participations: input.participations, runs: input.runs }, today);
  if (!info || !(info.phase === "active" || info.phase === "raceWeek" || info.phase === "open")) return null;
  const week = currentWeek(plan, today);
  if (!week?.startDate) return null;
  const end = addDays(week.startDate, 6);
  if (run.date < week.startDate || run.date > end) return null;

  let header: WeekModel["header"], weekN: number, weekM: number;
  if (info.phase === "open") {
    const g = plan.goal;
    const per = Number(g?.blockWeeks) > 0 ? Number(g?.blockWeeks) : 4;
    const elapsed = g?.startDate ? Math.max(0, Math.floor((Date.parse(week.startDate) - Date.parse(g.startDate)) / (7 * 86400000))) : 0;
    header = { kind: "block", block: info.block };
    weekN = (elapsed % per) + 1;
    weekM = per;
  } else {
    const race = mainRace(plan, input.settings);
    if (!race) return null;
    header = { kind: "race", title: input.raceLabel ?? null, daysToGo: Math.max(0, -info.daysSince) };
    weekN = week.weekNumber;
    weekM = race.wNum;
  }

  const linked = input.session || settledSession(plan, run);
  // An unlinked run never claims the day's planned session: that dot keeps its own state.
  const days: WeekDay[] = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(week.startDate as string, i);
    const sess = week.sessions.filter(s => s.date === date && !s.skipped);
    const isRunDay = date === run.date;
    const state: DayState = sess.some(s => s.done) || (isRunDay && (!!linked || !sess.length)) ? "done" : sess.length ? "open" : "rest";
    return { date, state, isRunDay };
  });
  const sessions = week.sessions.filter(s => !s.skipped);
  const pending = input.session && !input.session.done && sessions.some(s => s.id === input.session?.id) ? 1 : 0;
  const weekKm = input.runs
    .filter(r => r.date >= week.startDate! && r.date <= end && !isCrossTraining(r) && r !== run && (!run.id || r.id !== run.id))
    .reduce((s, r) => s + (Number(r.km) || 0), isCrossTraining(run) ? 0 : Number(run.km) || 0);
  const type = String(linked?.type || run.type || "").toUpperCase();
  return {
    header, weekN, weekM,
    phase: week.phase ? { key: `common.phases.${week.phase}` } : null,
    days,
    done: sessions.filter(s => s.done).length + pending,
    planned: sessions.length,
    weekKm: Math.round(weekKm * 10) / 10,
    runDay: run.date === today ? { today: true } : { today: false, weekday: Math.round((Date.parse(run.date) - Date.parse(week.startDate)) / 86400000) },
    // The finish screen's run isn't typed yet: no type claimed, just "today's run".
    runType: linked || input.session === undefined ? { key: `common.types.${type || "EASY"}` } : { key: "shareCard.week.run" },
    stats: statsFor(run, showPace),
  };
}
