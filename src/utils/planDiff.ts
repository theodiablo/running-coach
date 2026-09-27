import type { Plan, PlanSession } from "../types";
import { ymd } from "./format";

// What a rebuild would change in the sessions still ahead, by calendar date —
// ids name grid slots, so two plans' ids don't identify the same session.
// The past is left out: carryProgress keeps it, so nothing there changes.

export type SessionChange = { date: string; before: PlanSession | null; after: PlanSession | null };
export type WeekDiff = { start: string; kmBefore: number; kmAfter: number; changes: SessionChange[] };
export type PlanDiff = { weeks: WeekDiff[]; changed: number; keptDone: number; raceDateMoved: boolean };

const km = (s: PlanSession) => Number(s.km) || 0;
const same = (a: PlanSession, b: PlanSession) => a.type === b.type && km(a) === km(b) && a.desc === b.desc;

const mondayOf = (date: string) => {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return ymd(d);
};

const byDate = (plan: Plan | null, from: string) => {
  const m = new Map<string, PlanSession[]>();
  for (const w of plan?.weeks ?? []) for (const s of w.sessions) {
    if (s.date < from) continue;
    m.set(s.date, [...(m.get(s.date) ?? []), s]);
  }
  return m;
};

// Pairs one day's sessions, same type first, so a day holding two can't cross them.
const pairDay = (date: string, before: PlanSession[], after: PlanSession[]): SessionChange[] => {
  const left = after.slice();
  const out: SessionChange[] = [];
  for (const b of before) {
    let i = left.findIndex(a => a.type === b.type);
    if (i < 0) i = left.length ? 0 : -1;
    const a = i < 0 ? null : left.splice(i, 1)[0];
    if (!a || !same(b, a)) out.push({ date, before: b, after: a });
  }
  left.forEach(a => out.push({ date, before: null, after: a }));
  return out;
};

export function diffPlans(oldPlan: Plan | null, newPlan: Plan, today: Date): PlanDiff {
  const from = ymd(today);
  const oldDays = byDate(oldPlan, from);
  const newDays = byDate(newPlan, from);
  const weeks = new Map<string, WeekDiff>();
  const weekOf = (date: string) => {
    const start = mondayOf(date);
    if (!weeks.has(start)) weeks.set(start, { start, kmBefore: 0, kmAfter: 0, changes: [] });
    return weeks.get(start)!;
  };
  const dates = [...new Set([...oldDays.keys(), ...newDays.keys()])].sort();
  for (const date of dates) {
    const before = oldDays.get(date) ?? [];
    const after = newDays.get(date) ?? [];
    const w = weekOf(date);
    w.kmBefore += before.reduce((n, s) => n + km(s), 0);
    w.kmAfter += after.reduce((n, s) => n + km(s), 0);
    w.changes.push(...pairDay(date, before, after));
  }
  const list = [...weeks.values()].sort((a, b) => a.start.localeCompare(b.start));
  return {
    weeks: list,
    changed: list.reduce((n, w) => n + w.changes.length, 0),
    keptDone: newPlan.weeks.flatMap(w => w.sessions).filter(s => s.done).length,
    raceDateMoved: !!oldPlan && oldPlan.raceDate !== newPlan.raceDate,
  };
}
