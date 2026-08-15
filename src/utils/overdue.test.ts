import { describe, it, expect } from "vitest";
import { overdueSessions, nextSession, overdueByWeek } from "./overdue";
import type { Plan } from "../types";

const sess = (id: string, date: string, extra: Record<string, unknown> = {}) =>
  ({id, date, type: "EASY", desc: "Easy run", km: 5, pace: 360, ...extra});

const planOf = (weeks: {weekNumber: number; sessions: ReturnType<typeof sess>[]}[]) =>
  ({weeks: weeks.map(w => ({...w, startDate: w.sessions[0]?.date || "", phase: "base"}))} as unknown as Plan);

const today = new Date("2026-03-10T09:30:00");

describe("overdueSessions", () => {
  it("returns untouched past sessions, most recent first", () => {
    const plan = planOf([{weekNumber: 1, sessions: [
      sess("a", "2026-03-05"), sess("b", "2026-03-08"), sess("c", "2026-03-07"),
    ]}]);
    expect(overdueSessions(plan, today).map(s => s.id)).toEqual(["b", "c", "a"]);
  });

  it("excludes done and skipped sessions", () => {
    const plan = planOf([{weekNumber: 1, sessions: [
      sess("done", "2026-03-05", {done: true}),
      sess("skipped", "2026-03-06", {skipped: true}),
      sess("open", "2026-03-07"),
    ]}]);
    expect(overdueSessions(plan, today).map(s => s.id)).toEqual(["open"]);
  });

  it("treats today as not overdue, and ignores the current clock time", () => {
    const plan = planOf([{weekNumber: 1, sessions: [sess("today", "2026-03-10"), sess("yesterday", "2026-03-09")]}]);
    // 09:30 on the day itself must not push today's session into overdue.
    expect(overdueSessions(plan, today).map(s => s.id)).toEqual(["yesterday"]);
  });

  it("carries the week number so actions can target the session", () => {
    const plan = planOf([
      {weekNumber: 4, sessions: [sess("a", "2026-03-05")]},
      {weekNumber: 5, sessions: [sess("b", "2026-03-08")]},
    ]);
    expect(overdueSessions(plan, today).map(s => s.wNum)).toEqual([5, 4]);
  });

  it("returns empty for a null or week-less plan", () => {
    expect(overdueSessions(null, today)).toEqual([]);
    expect(overdueSessions({weeks: []} as unknown as Plan, today)).toEqual([]);
  });

  // A rebuild keeps up to 8 elapsed weeks, so without a floor a plan carries
  // months of untouched sessions that would all read as "still open" forever.
  it("stops looking back at the lookback floor", () => {
    const plan = planOf([{weekNumber: 1, sessions: [
      sess("edge", "2026-02-24"),   // exactly 14 days back — still open
      sess("stale", "2026-02-23"),  // 15 days back — the plan has moved on
    ]}]);
    expect(overdueSessions(plan, today).map(s => s.id)).toEqual(["edge"]);
  });

  it("keeps a stale session out of the per-week counts too", () => {
    const plan = planOf([
      {weekNumber: 1, sessions: [sess("old", "2026-02-10")]},
      {weekNumber: 2, sessions: [sess("recent", "2026-03-06")]},
    ]);
    expect(overdueByWeek(plan, today)).toEqual({2: 1});
  });
});

describe("nextSession", () => {
  it("picks the soonest untouched session from today onward", () => {
    const plan = planOf([{weekNumber: 1, sessions: [
      sess("past", "2026-03-08"), sess("today", "2026-03-10"), sess("later", "2026-03-12"),
    ]}]);
    expect(nextSession(plan, today)?.id).toBe("today");
  });

  it("skips done/skipped future sessions", () => {
    const plan = planOf([{weekNumber: 1, sessions: [
      sess("t", "2026-03-10", {done: true}), sess("next", "2026-03-11"),
    ]}]);
    expect(nextSession(plan, today)?.id).toBe("next");
  });

  it("returns null when nothing is left", () => {
    expect(nextSession(planOf([{weekNumber: 1, sessions: [sess("a", "2026-03-01")]}]), today)).toBeNull();
    expect(nextSession(null, today)).toBeNull();
  });

  it("never returns a session that overdueSessions also claims", () => {
    const plan = planOf([{weekNumber: 1, sessions: [
      sess("a", "2026-03-08"), sess("b", "2026-03-10"), sess("c", "2026-03-14"),
    ]}]);
    const overdueIds = new Set(overdueSessions(plan, today).map(s => s.id));
    expect(overdueIds.has(String(nextSession(plan, today)?.id))).toBe(false);
  });
});

describe("overdueByWeek", () => {
  it("counts overdue sessions per week number", () => {
    const plan = planOf([
      {weekNumber: 1, sessions: [sess("a", "2026-03-02"), sess("b", "2026-03-03"), sess("c", "2026-03-04", {done: true})]},
      {weekNumber: 2, sessions: [sess("d", "2026-03-09")]},
      {weekNumber: 3, sessions: [sess("e", "2026-03-14")]},
    ]);
    expect(overdueByWeek(plan, today)).toEqual({1: 2, 2: 1});
  });
});
