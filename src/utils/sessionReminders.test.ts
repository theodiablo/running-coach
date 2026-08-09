import { describe, it, expect } from "vitest";
import {
  reminderSchedule, reminderId, fireAt, nextReminderPreview,
  MAX_PENDING, DEFAULT_REMINDER_PREFS, type ReminderPrefs,
} from "./sessionReminders";
import type { Plan } from "../types";

const sess = (id: string, date: string, extra: Record<string, unknown> = {}) =>
  ({id, date, type: "EASY", desc: "Easy run 5km", km: 5, pace: 360, ...extra});

const planOf = (sessions: ReturnType<typeof sess>[]) =>
  ({weeks: [{weekNumber: 1, startDate: sessions[0]?.date || "", phase: "base", sessions}]} as unknown as Plan);

const on: ReminderPrefs = {enabled: true, time: "18:00", leadDays: 1};
const now = new Date(2026, 2, 10, 9, 0); // 2026-03-10 09:00 local

describe("reminderId", () => {
  it("is stable across calls", () => {
    expect(reminderId("sess-abc")).toBe(reminderId("sess-abc"));
  });

  it("stays inside a positive 31-bit Java int", () => {
    for (const id of ["a", "sess-abc", "w3-long-2026-03-14", "", "é🏃"]) {
      const n = reminderId(id);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(0x7fffffff);
    }
  });

  it("separates distinct session ids", () => {
    const ids = ["s1", "s2", "s3", "w1-easy", "w1-long"].map(reminderId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("fireAt", () => {
  it("fires the evening before at the chosen time when leadDays is 1", () => {
    const at = fireAt("2026-03-14", {enabled: true, time: "18:30", leadDays: 1});
    expect([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()])
      .toEqual([2026, 2, 13, 18, 30]);
  });

  it("fires on the morning of the session when leadDays is 0", () => {
    const at = fireAt("2026-03-14", {enabled: true, time: "07:00", leadDays: 0});
    expect([at.getDate(), at.getHours()]).toEqual([14, 7]);
  });

  it("rolls back across a month boundary", () => {
    const at = fireAt("2026-03-01", {enabled: true, time: "18:00", leadDays: 1});
    expect([at.getMonth(), at.getDate()]).toEqual([1, 28]); // 2026-02-28
  });

  it("falls back to a sane time on a malformed preference", () => {
    const at = fireAt("2026-03-14", {enabled: true, time: "nonsense", leadDays: 0});
    expect([at.getHours(), at.getMinutes()]).toEqual([18, 0]);
  });
});

describe("reminderSchedule", () => {
  it("returns nothing when disabled", () => {
    expect(reminderSchedule(planOf([sess("a", "2026-03-14")]), {...on, enabled: false}, now)).toEqual([]);
  });

  it("returns nothing for a null plan", () => {
    expect(reminderSchedule(null, on, now)).toEqual([]);
  });

  it("skips done and skipped sessions", () => {
    const plan = planOf([
      sess("done", "2026-03-14", {done: true}),
      sess("skipped", "2026-03-15", {skipped: true}),
      sess("open", "2026-03-16"),
    ]);
    expect(reminderSchedule(plan, on, now).map(r => r.sessionId)).toEqual(["open"]);
  });

  it("skips reminders whose fire time has already passed", () => {
    // At 09:00 on the 10th, the 18:00-on-the-9th reminder for the 10th is gone,
    // but the 18:00-on-the-10th reminder for the 11th is still ahead.
    const plan = planOf([sess("today", "2026-03-10"), sess("tomorrow", "2026-03-11")]);
    expect(reminderSchedule(plan, on, now).map(r => r.sessionId)).toEqual(["tomorrow"]);
  });

  it("orders soonest first", () => {
    const plan = planOf([sess("c", "2026-03-20"), sess("a", "2026-03-12"), sess("b", "2026-03-15")]);
    expect(reminderSchedule(plan, on, now).map(r => r.sessionId)).toEqual(["a", "b", "c"]);
  });

  it("caps at MAX_PENDING, keeping the soonest", () => {
    const sessions = Array.from({length: 60}, (_, i) => {
      const d = new Date(2026, 2, 12 + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return sess("s" + i, iso);
    });
    const got = reminderSchedule(planOf(sessions), on, now);
    expect(got).toHaveLength(MAX_PENDING);
    expect(got[0].sessionId).toBe("s0");
    expect(got.at(-1)!.sessionId).toBe("s" + (MAX_PENDING - 1));
  });

  it("honours an explicit max", () => {
    const plan = planOf([sess("a", "2026-03-12"), sess("b", "2026-03-13"), sess("c", "2026-03-14")]);
    expect(reminderSchedule(plan, on, now, 2).map(r => r.sessionId)).toEqual(["a", "b"]);
  });

  it("derives ids that match reminderId, so a later sync can cancel them", () => {
    const plan = planOf([sess("w2-long", "2026-03-14")]);
    expect(reminderSchedule(plan, on, now)[0].id).toBe(reminderId("w2-long"));
  });

  it("gives every reminder a non-empty title and body", () => {
    const plan = planOf([sess("a", "2026-03-14")]);
    const r = reminderSchedule(plan, on, now)[0];
    expect(r.title.length).toBeGreaterThan(0);
    expect(r.body).toContain("km");
  });

  it("is idempotent — same inputs, same ids and times", () => {
    const plan = planOf([sess("a", "2026-03-12"), sess("b", "2026-03-15")]);
    const a = reminderSchedule(plan, on, now);
    const b = reminderSchedule(plan, on, now);
    expect(a.map(r => [r.id, r.at.getTime()])).toEqual(b.map(r => [r.id, r.at.getTime()]));
  });
});

describe("nextReminderPreview", () => {
  it("returns the soonest fire time", () => {
    const plan = planOf([sess("b", "2026-03-15"), sess("a", "2026-03-12")]);
    expect(nextReminderPreview(plan, on, now)).toEqual(fireAt("2026-03-12", on));
  });

  it("returns null when nothing is scheduled", () => {
    expect(nextReminderPreview(planOf([sess("a", "2026-03-01")]), on, now)).toBeNull();
    expect(nextReminderPreview(null, on, now)).toBeNull();
  });
});

describe("DEFAULT_REMINDER_PREFS", () => {
  it("ships off, so nothing schedules until the user opts in", () => {
    expect(DEFAULT_REMINDER_PREFS.enabled).toBe(false);
  });
});
