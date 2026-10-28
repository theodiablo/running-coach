import { describe, it, expect } from "vitest";
import { RECOVERY_RULES, canHoldTraining, goalKind, inRecovery, recentRace, recoveryRule } from "./recovery";
import type { Participation, Plan, Run, SettingsState } from "../types";

const plan = (extra: Record<string, unknown> = {}) =>
  ({ raceDate: "2026-06-14", weeks: [], ...extra }) as unknown as Plan;

describe("recoveryRule", () => {
  it.each([
    [0, 4, 1], [5, 4, 1], [7.5, 4, 1], [7.6, 6, 2], [10, 6, 2], [16, 6, 2], [16.1, 12, 2], [21.1, 12, 2],
    [30, 12, 2], [30.5, 21, 3], [42.2, 21, 3], [45, 21, 3], [45.1, 26, 4], [100, 26, 4],
  ])("%s km leaves %i easy-only days after %i of rest", (km, days, rest) => {
    expect(recoveryRule(km)).toMatchObject({ days, rest });
  });

  it("is bracketed in order, longest last, with a rest inside every window", () => {
    expect(RECOVERY_RULES.map(r => r.days)).toEqual([...RECOVERY_RULES.map(r => r.days)].sort((a, b) => a - b));
    expect(RECOVERY_RULES.every(r => r.rest < r.days)).toBe(true);
    expect(recoveryRule(NaN)).toMatchObject({ days: 4 });
  });
});

describe("goalKind", () => {
  it.each([[undefined, "race"], [{ kind: "race" }, "race"], [{ kind: "block" }, "block"], [{ kind: "open" }, "open"], [{ kind: "bogus" }, "race"]])(
    "%j reads as %s", (goal, kind) => {
      expect(goalKind(plan(goal ? { goal } : {}))).toBe(kind);
    });
});

describe("canHoldTraining", () => {
  const withTail = plan({ recovery: { race: "2026-06-14", km: 10, until: "2026-06-20" } });

  it("holds the days before the race, never race day", () => {
    expect(canHoldTraining(plan(), "2026-06-13")).toBe(true);
    expect(canHoldTraining(plan(), "2026-06-14")).toBe(false);
    expect(canHoldTraining(withTail, "2026-06-14")).toBe(false);
  });

  it("holds the days after it only inside the recovery the plan was written with", () => {
    expect(canHoldTraining(plan(), "2026-06-15")).toBe(false);
    expect(canHoldTraining(withTail, "2026-06-15")).toBe(true);
    expect(canHoldTraining(withTail, "2026-06-20")).toBe(true);
    expect(canHoldTraining(withTail, "2026-06-21")).toBe(false);
  });

  it("is not about a race for any other kind of plan", () => {
    for (const kind of ["block", "open"]) {
      expect(canHoldTraining(plan({ goal: { kind } }), "2026-06-14")).toBe(true);
      expect(canHoldTraining(plan({ goal: { kind }, raceDate: undefined }), "2030-01-01")).toBe(true);
    }
  });
});

describe("inRecovery", () => {
  it("covers (race, until] of the plan's own tail, and of the race a plan opened behind", () => {
    for (const key of ["recovery", "openedAfter"]) {
      const p = plan({ [key]: { race: "2026-06-14", km: 10, until: "2026-06-20" } });
      expect(inRecovery(p, "2026-06-14")).toBe(false);
      expect(inRecovery(p, "2026-06-15")).toBe(true);
      expect(inRecovery(p, "2026-06-20")).toBe(true);
      expect(inRecovery(p, "2026-06-21")).toBe(false);
    }
  });

  it("covers every day of a RECOVERY week", () => {
    const p = plan({ weeks: [{ weekNumber: 1, startDate: "2026-06-15", phase: "RECOVERY", sessions: [] }] });
    expect(inRecovery(p, "2026-06-14")).toBe(false);
    expect(inRecovery(p, "2026-06-15")).toBe(true);
    expect(inRecovery(p, "2026-06-21")).toBe(true);
    expect(inRecovery(p, "2026-06-22")).toBe(false);
  });

  it("is false for a plan with no window", () => {
    expect(inRecovery(plan(), "2026-06-16")).toBe(false);
    expect(inRecovery(null, "2026-06-16")).toBe(false);
  });
});

describe("recentRace", () => {
  const TODAY = "2026-07-01";
  const settings = { raceDate: "2026-06-14", targetEditionId: null } as unknown as SettingsState;
  const raceRun = (id: string, date: string, km = 10): Run => ({ id, date, type: "RACE", km, durationSec: km * 330 });
  const part = (over: Partial<Participation>): Participation =>
    ({ editionId: "ed", status: "done", raceDate: "2026-06-25", distanceKm: 21.1, ...over }) as Participation;
  const run = (runs: Run[], participations: Participation[] = [], p: Plan | null = null) =>
    recentRace({ plan: p, participations, runs, settings }, TODAY);

  it("finds a race-typed run of at least 3 km in the last two weeks", () => {
    expect(run([raceRun("a", "2026-06-20", 5)])).toEqual({ date: "2026-06-20", km: 5 });
    expect(run([raceRun("a", "2026-06-20", 2.5)])).toBeNull();
    expect(run([{ ...raceRun("a", "2026-06-20"), type: "EASY" }])).toBeNull();
  });

  it("is bounded to [today - 14, today)", () => {
    expect(run([raceRun("a", "2026-06-17")])).toEqual({ date: "2026-06-17", km: 10 });
    expect(run([raceRun("a", "2026-06-16")])).toBeNull();
    expect(run([raceRun("a", "2026-07-01")])).toBeNull();
  });

  it("reads a done participation, and the latest of several", () => {
    expect(run([], [part({})])).toEqual({ date: "2026-06-25", km: 21.1 });
    expect(run([raceRun("a", "2026-06-20")], [part({})])).toEqual({ date: "2026-06-25", km: 21.1 });
    expect(run([], [part({ status: "wishlist" })])).toBeNull();
  });

  it("reads the plan's own race once settled", () => {
    const p = plan({
      raceDate: "2026-06-24",
      weeks: [{ weekNumber: 1, startDate: "2026-06-22", phase: "RACE", sessions: [
        { id: "race", date: "2026-06-24", type: "RACE", km: 42.2, pace: 300, desc: "", done: true, runId: "r" }] }],
    });
    expect(run([], [], p)).toEqual({ date: "2026-06-24", km: 42.2 });
  });
});
