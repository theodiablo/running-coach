import { t } from "../i18n";
import { fmt } from "./format";
import { describeSession } from "./sessionDesc";
import type { Plan, PlanSession, SettingsState } from "../types";

// Pure scheduling math for plan-session reminders. Device-free on purpose: the
// native seam (src/notify/sessionReminders.ts) does nothing but hand this list
// to the OS scheduler, so everything that can be got wrong is testable here.

export type ReminderPrefs = {
  enabled: boolean;
  // "HH:MM", local time.
  time: string;
  // 0 = morning of the session, 1 = the evening before.
  leadDays: 0 | 1;
};

export type ScheduledReminder = {
  id: number;
  at: Date;
  sessionId: string;
  title: string;
  body: string;
};

export const DEFAULT_REMINDER_PREFS: ReminderPrefs = {enabled: false, time: "18:00", leadDays: 1};

// Read the synced preference into the shape the scheduler wants. Absent fields
// mean "off at the defaults", which is exactly what every web session sees.
export const prefsFrom = (s: SettingsState): ReminderPrefs => ({
  enabled: !!s.sessionReminders,
  time: s.reminderTime || DEFAULT_REMINDER_PREFS.time,
  leadDays: s.reminderLeadDays === 0 ? 0 : 1,
});

// iOS keeps at most 64 pending local notifications and silently drops the rest;
// a 12-week plan carries ~48 sessions. Half the budget leaves room for anything
// else that ever schedules, and the list is re-synced on every plan change
// anyway, so the tail is never far away.
export const MAX_PENDING = 32;

// Notification ids are Java ints on Android, so the hash is folded into 31 bits.
// It must be STABLE across launches: cancelling a reminder means re-deriving the
// same id from the same session id later. Collisions are possible in principle
// and harmless in practice — the worst case is one reminder replacing another,
// and the next sync restores it.
export function reminderId(sessionId: string): number {
  let h = 5381;
  for (let i = 0; i < sessionId.length; i++) h = ((h * 33) ^ sessionId.charCodeAt(i)) | 0;
  return Math.abs(h) & 0x7fffffff;
}

function parseTime(time: string): {hh: number; mm: number} {
  const [h, m] = String(time).split(":");
  const hh = Number(h), mm = Number(m);
  return {
    hh: Number.isFinite(hh) ? Math.min(23, Math.max(0, Math.trunc(hh))) : 18,
    mm: Number.isFinite(mm) ? Math.min(59, Math.max(0, Math.trunc(mm))) : 0,
  };
}

// When a session dated `date` should ping, in local time.
export function fireAt(date: string, prefs: ReminderPrefs): Date {
  const [y, m, d] = date.split("-").map(Number);
  const {hh, mm} = parseTime(prefs.time);
  return new Date(y, (m || 1) - 1, (d || 1) - prefs.leadDays, hh, mm, 0, 0);
}

function textFor(s: PlanSession, prefs: ReminderPrefs) {
  const title = prefs.leadDays === 1 ? t("reminders.notif.tomorrow") : t("reminders.notif.today");
  const type = t("common.types." + s.type, {defaultValue: String(s.type)});
  return {title, body: type + " · " + describeSession(s) + " · " + fmt.pace(s.pace) + "/km"};
}

// Every reminder that should currently be pending, soonest first.
//
// Only future, untouched sessions qualify — a done/skipped session must never
// ping, which is why this is recomputed from the plan on every change rather
// than incrementally patched.
export function reminderSchedule(
  plan: Plan | null,
  prefs: ReminderPrefs,
  now: Date,
  max: number = MAX_PENDING,
): ScheduledReminder[] {
  if (!prefs.enabled || !plan?.weeks?.length) return [];
  const out: ScheduledReminder[] = [];
  for (const w of plan.weeks) {
    for (const s of w.sessions) {
      if (s.done || s.skipped || !s.date) continue;
      const at = fireAt(s.date, prefs);
      if (at.getTime() <= now.getTime()) continue;
      const {title, body} = textFor(s, prefs);
      out.push({id: reminderId(s.id), at, sessionId: s.id, title, body});
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, Math.max(0, max));
}

// Short "next up" line for the settings screen, so the toggle can say what the
// user will actually receive. Null when nothing is scheduled.
export function nextReminderPreview(plan: Plan | null, prefs: ReminderPrefs, now: Date): Date | null {
  return reminderSchedule(plan, prefs, now, 1)[0]?.at ?? null;
}
