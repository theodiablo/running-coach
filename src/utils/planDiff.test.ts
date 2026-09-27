import { describe, expect, it } from "vitest";
import { diffPlans } from "./planDiff";
import type { Plan, PlanSession } from "../types";

const s = (date: string, type: string, km: number, extra: Partial<PlanSession> = {}): PlanSession =>
  ({ id: "x" + date + type, date, type, km, pace: 360, desc: type + " " + km, ...extra });
const plan = (sessions: PlanSession[], raceDate = "2026-11-08"): Plan =>
  ({ raceDate, weeks: [{ weekNumber: 1, startDate: "2026-09-14", sessions }] });
const TODAY = new Date("2026-09-27T10:00:00");

describe("diffPlans", () => {
  it("reports nothing for an identical rebuild, even with fresh ids", () => {
    const a = plan([s("2026-09-29", "EASY", 6), s("2026-10-04", "LONG", 14)]);
    const b = plan([s("2026-09-29", "EASY", 6, { id: "w1d1" }), s("2026-10-04", "LONG", 14, { id: "w1d6" })]);
    const d = diffPlans(a, b, TODAY);
    expect(d.changed).toBe(0);
    expect(d.weeks.every(w => w.changes.length === 0)).toBe(true);
  });

  it("ignores the past, which a rebuild keeps", () => {
    const a = plan([s("2026-09-20", "LONG", 7), s("2026-09-29", "EASY", 6)]);
    const b = plan([s("2026-09-20", "LONG", 9), s("2026-09-29", "EASY", 6)]);
    expect(diffPlans(a, b, TODAY).changed).toBe(0);
  });

  it("pairs changes by date and groups them by Monday week with volumes", () => {
    const a = plan([s("2026-09-29", "EASY", 6.3), s("2026-10-01", "TEMPO", 6.3), s("2026-10-04", "LONG", 14.5), s("2026-10-06", "EASY", 5)]);
    const b = plan([s("2026-09-29", "EASY", 5.9), s("2026-10-01", "EASY", 5.9), s("2026-10-04", "LONG", 14.5), s("2026-10-06", "EASY", 5)]);
    const d = diffPlans(a, b, TODAY);
    expect(d.changed).toBe(2);
    expect(d.weeks.map(w => w.start)).toEqual(["2026-09-28", "2026-10-05"]);
    const [wk] = d.weeks;
    expect(wk.kmBefore).toBeCloseTo(27.1);
    expect(wk.kmAfter).toBeCloseTo(26.3);
    expect(wk.changes.map(c => [c.date, c.before?.type, c.after?.type])).toEqual([
      ["2026-09-29", "EASY", "EASY"],
      ["2026-10-01", "TEMPO", "EASY"],
    ]);
    expect(d.weeks[1].changes).toEqual([]);
  });

  it("lists added and removed sessions", () => {
    const a = plan([s("2026-09-29", "EASY", 6)]);
    const b = plan([s("2026-09-30", "EASY", 6)]);
    const d = diffPlans(a, b, TODAY);
    expect(d.weeks[0].changes).toEqual([
      { date: "2026-09-29", before: expect.objectContaining({ type: "EASY" }), after: null },
      { date: "2026-09-30", before: null, after: expect.objectContaining({ type: "EASY" }) },
    ]);
  });

  it("counts a description change (e.g. a new pace) as a change", () => {
    const a = plan([s("2026-10-01", "TEMPO", 6, { desc: "Tempo 5:07/km" })]);
    const b = plan([s("2026-10-01", "TEMPO", 6, { desc: "Tempo 5:00/km" })]);
    expect(diffPlans(a, b, TODAY).changed).toBe(1);
  });

  it("keeps a race and a session on the same day paired by type", () => {
    const a = plan([s("2026-10-11", "RACE", 10), s("2026-10-11", "EASY", 3)]);
    const b = plan([s("2026-10-11", "EASY", 3), s("2026-10-11", "RACE", 10)]);
    expect(diffPlans(a, b, TODAY).changed).toBe(0);
  });

  it("counts kept completed sessions and flags a moved race date", () => {
    const a = plan([s("2026-09-20", "LONG", 7, { done: true })]);
    const b = plan([s("2026-09-20", "LONG", 7, { done: true })], "2026-11-15");
    const d = diffPlans(a, b, TODAY);
    expect(d.keptDone).toBe(1);
    expect(d.raceDateMoved).toBe(true);
  });
});
