// Home's "This week" strip: one dot per day, Monday first. Derived on every read, never stored.

import { isCrossTraining } from "../types";
import { weekStart, ymd } from "./format";
import type { Plan, Run } from "../types";

// "open" is a past planned session nobody settled: amber in the UI, never red (docs/reminders.md).
export type WeekDayState = "done" | "planned" | "open" | "rest";
export type WeekDay = { date: string; state: WeekDayState; today: boolean };
export type WeekStrip = { days: WeekDay[]; sessions: number; done: number; runs: number; km: number };

export function weekStrip(plan: Plan | null, runs: Run[], today: Date): WeekStrip {
  const mon = weekStart(today);
  const todayStr = ymd(today);
  const dates = Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setDate(d.getDate() + i); return ymd(d); });
  const inWeek = (d: string) => d >= dates[0] && d <= dates[6];
  const sessions = (plan?.weeks || []).flatMap(w => w.sessions).filter(s => inWeek(s.date));
  const weekRuns = runs.filter(r => inWeek(r.date));
  const days = dates.map(date => {
    const sess = sessions.filter(s => s.date === date);
    const ran = weekRuns.some(r => r.date === date);
    const pending = sess.some(s => !s.done && !s.skipped);
    const state: WeekDayState = ran || sess.some(s => s.done) ? "done"
      : pending ? (date < todayStr ? "open" : "planned") : "rest";
    return { date, state, today: date === todayStr };
  });
  const km = weekRuns.filter(r => !isCrossTraining(r)).reduce((s, r) => s + (r.km || 0), 0);
  return { days, sessions: sessions.length, done: sessions.filter(s => s.done).length, runs: weekRuns.length, km };
}
