// When Home suggests a stretch, and which one. Derived on every render from the
// runs, the plan and the stretch log, never stored (the same rule as overdue
// sessions). At most one suggestion a day. Rules: docs/stretching.md.

import { isCrossTraining } from "../types";
import type { Plan, Run } from "../types";
import type { CooldownFocus, RoutineId } from "../stretch/routines";
import { weekKey, ymd } from "./format";

export type StretchLogEntry = { date: string; at: number; routine: RoutineId; sec: number };

export const STRETCH_LOG_CAP = 200;

/** A cool-down after a run today, or a recovery session the day after a big one. */
export type StretchSuggestion =
  | { routine: "cooldown"; focus: CooldownFocus; km: number }
  | { routine: "recovery"; km: number; race: boolean };

export const MIN_RUN_SEC = 15 * 60;
export const BIG_RUN_SEC = 90 * 60;
/** Metres of climb per km from which a run counts as hilly. */
export const HILLY_M_PER_KM = 15;

const HARD_TYPES = new Set(["TEMPO", "INTERVALS", "RACE"]);
const typeOf = (r: { type?: unknown }) => String(r.type ?? "").toUpperCase();

const counts = (r: Run) => !isCrossTraining(r) && (Number(r.km) || 0) > 0 && (r.durationSec ?? 0) >= MIN_RUN_SEC;

/** When a run ended, if it says when it started; null for a hand-logged run. */
function runEndMs(r: Run): number | null {
  const start = r.startedAt ? Date.parse(r.startedAt) : NaN;
  return Number.isFinite(start) ? start + (r.durationSec ?? 0) * 1000 : null;
}

export function cooldownFocus(r: Run): CooldownFocus {
  const km = Number(r.km) || 0;
  if (km > 0 && (Number(r.elevation) || 0) / km >= HILLY_M_PER_KM) return "hills";
  if (HARD_TYPES.has(typeOf(r))) return "hard";
  return "standard";
}

// A run's `date` is the day it started, so one that ran past midnight belongs to both.
const endsOn = (r: Run, day: string) => { const end = runEndMs(r); return end !== null && ymd(new Date(end)) === day; };

function hardSessionToday(plan: Plan | null, day: string): boolean {
  return !!plan?.weeks?.some(w => w.sessions.some(s =>
    s.date === day && !s.done && !s.skipped && HARD_TYPES.has(typeOf(s))));
}

export function stretchSuggestion(args: {
  runs: Run[];
  plan: Plan | null;
  log: StretchLogEntry[];
  now: Date;
  enabled?: boolean;
  dismissedOn?: string;
}): StretchSuggestion | null {
  const { runs, plan, log, now, enabled = true, dismissedOn } = args;
  const today = ymd(now);
  if (!enabled || dismissedOn === today) return null;
  const stretchedToday = log.filter(e => e.date === today);

  const ranToday = runs.filter(r => (r.date === today || endsOn(r, today)) && counts(r));
  if (ranToday.length) {
    const ends = ranToday.map(runEndMs);
    const lastEnd = ends.every(e => e !== null) ? Math.max(...(ends as number[])) : null;
    const covered = lastEnd === null ? stretchedToday.length > 0 : stretchedToday.some(e => e.at >= lastEnd);
    if (covered) return null;
    const main = ranToday.reduce((a, b) => ((b.durationSec ?? 0) > (a.durationSec ?? 0) ? b : a));
    const km = ranToday.reduce((sum, r) => sum + (Number(r.km) || 0), 0);
    return { routine: "cooldown", focus: cooldownFocus(main), km };
  }

  if (stretchedToday.length || hardSessionToday(plan, today)) return null;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const yesterday = ymd(y);
  const big = runs.find(r => r.date === yesterday && counts(r)
    && (typeOf(r) === "LONG" || typeOf(r) === "RACE" || (r.durationSec ?? 0) >= BIG_RUN_SEC));
  if (!big) return null;
  return { routine: "recovery", km: Number(big.km) || 0, race: typeOf(big) === "RACE" };
}

/** Sessions logged since Monday: a count to show, never a streak. */
export function stretchesThisWeek(log: StretchLogEntry[], now: Date): number {
  const monday = new Date(now);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const from = ymd(monday);
  return log.filter(e => e.date >= from && e.date <= ymd(now)).length;
}

/** One Monday-to-Sunday week of the log, its sessions newest first. */
export type StretchWeek = { start: string; entries: StretchLogEntry[]; sec: number };

/** The log as weeks, newest first; weeks with nothing logged are left out, never shown as gaps. */
export function stretchWeeks(log: StretchLogEntry[]): StretchWeek[] {
  const byWeek = new Map<string, StretchLogEntry[]>();
  for (const e of log) {
    const k = weekKey(e.date);
    byWeek.set(k, [...(byWeek.get(k) ?? []), e]);
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([start, entries]) => ({
      start,
      entries: [...entries].sort((a, b) => b.at - a.at),
      sec: entries.reduce((sum, e) => sum + e.sec, 0),
    }));
}

/** The stored log, keeping only well-formed entries (the blob is user-writable and restorable). */
export function readStretchLog(v: unknown): StretchLogEntry[] {
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is StretchLogEntry => !!e && typeof e === "object"
    && typeof e.date === "string" && typeof e.at === "number" && typeof e.routine === "string" && typeof e.sec === "number")
    .slice(-STRETCH_LOG_CAP);
}

export function appendStretchLog(log: StretchLogEntry[], entry: StretchLogEntry): StretchLogEntry[] {
  return [...log, entry].slice(-STRETCH_LOG_CAP);
}
