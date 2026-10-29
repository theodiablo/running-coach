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

// The finish line: a race is never "still open", and neither is the training
// that led up to a race that has passed. `today` is explicit, so no clock is read.
describe("overdueSessions around the main race", () => {
  const race = (date: string, extra: Record<string, unknown> = {}) =>
    sess("race", date, {type: "RACE", ...extra});
  const after = (days: number) => { const d = new Date("2026-03-10T09:30:00"); d.setDate(d.getDate() + days); return d; };

  it("never reports a RACE session, passed or not", () => {
    const plan = planOf([{weekNumber: 1, sessions: [race("2026-03-08"), sess("easy", "2026-03-07")]}]);
    // The race is yesterday: both the race and the run-up to it are history.
    expect(overdueSessions(plan, today)).toEqual([]);
    const secondary = planOf([{weekNumber: 1, sessions: [
      sess("main", "2026-03-20", {type: "RACE", id: "race"}),
      sess("race-ed1", "2026-03-08", {type: "RACE"}),
    ]}]);
    expect(overdueSessions(secondary, today)).toEqual([]);
  });

  it("drops every session dated on or before a passed main race", () => {
    const plan = planOf([{weekNumber: 1, sessions: [
      sess("a", "2026-03-04"), sess("b", "2026-03-07"), race("2026-03-08"),
    ]}]);
    expect(overdueSessions(plan, today)).toEqual([]);
  });

  it("still counts a session after the race", () => {
    const plan = planOf([
      {weekNumber: 1, sessions: [sess("before", "2026-03-04"), race("2026-03-06")]},
      {weekNumber: 2, sessions: [sess("after", "2026-03-08")]},
    ]);
    expect(overdueSessions(plan, today).map(s => s.id)).toEqual(["after"]);
    expect(overdueByWeek(plan, today)).toEqual({2: 1});
  });

  it("keeps the run-up open while the race is still ahead, race day included", () => {
    const plan = planOf([{weekNumber: 1, sessions: [sess("missed", "2026-03-08"), race("2026-03-10")]}]);
    expect(overdueSessions(plan, today).map(s => s.id)).toEqual(["missed"]);
    // The day after, the race has passed and takes the run-up with it.
    expect(overdueSessions(plan, after(1))).toEqual([]);
  });

  it("ignores carried history ids when finding the main race", () => {
    const plan = planOf([{weekNumber: 1, sessions: [
      sess("past-race", "2026-03-06", {type: "RACE"}), sess("open", "2026-03-07"),
    ]}]);
    // No live "race" session: only the RACE type itself is dropped.
    expect(overdueSessions(plan, today).map(s => s.id)).toEqual(["open"]);
  });

  it("keeps the cutoff after a rebuild renamed the passed race past-race", () => {
    const plan = planOf([{weekNumber: 1, sessions: [
      sess("past-w1d2", "2026-03-04"), sess("past-race", "2026-03-08", {type: "RACE"}), sess("w2d0", "2026-03-09"),
    ]}]);
    expect(overdueSessions(plan, today).map(s => s.id)).toEqual(["w2d0"]);
  });

  it("also cuts at the race a plan opened behind, or its own recovery race", () => {
    const base = planOf([{weekNumber: 1, sessions: [sess("old", "2026-03-04"), sess("new", "2026-03-09")]}]);
    for (const key of ["openedAfter", "recovery"])
      expect(overdueSessions({...base, [key]: {race: "2026-03-07", km: 10, until: "2026-03-13"}} as Plan, today)
        .map(s => s.id)).toEqual(["new"]);
    // A race still ahead cuts nothing.
    expect(overdueSessions({...base, openedAfter: {race: "2026-03-20", km: 10, until: "2026-03-26"}} as Plan, today)
      .map(s => s.id)).toEqual(["new", "old"]);
  });
});
