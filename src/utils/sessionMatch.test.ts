import { describe, it, expect } from "vitest";
import { bestSessionForRun, candidateRuns, canMoveSessionTo, claimedRunIds, MATCH_WINDOW_DAYS } from "./sessionMatch";
import type { Plan, PlanSession, Run } from "../types";

const sess = (id: string, date: string, extra: Partial<PlanSession> = {}): PlanSession =>
  ({ id, date, type: "EASY", desc: "Easy run", km: 8, pace: 360, done: false, runId: null, ...extra });

const planOf = (sessions: PlanSession[], startDate = "2026-03-09"): Plan =>
  ({ weeks: [{ weekNumber: 3, startDate, phase: "base", sessions }] } as unknown as Plan);

const run = (id: string, date: string, extra: Partial<Run> = {}): Run =>
  ({ id, date, type: "EASY", km: 8, durationSec: 2400, ...extra } as Run);

describe("candidateRuns", () => {
  const session = sess("w3d3", "2026-03-12"); // Thursday

  it("offers a run from a nearby day, not just the same one", () => {
    const runs = [run("a", "2026-03-11")];
    expect(candidateRuns(planOf([session]), session, runs).map(r => r.id)).toEqual(["a"]);
  });

  it("ranks by day gap first, then by how close the distance is", () => {
    const runs = [
      run("far-day", "2026-03-09", { km: 8 }),
      run("near-wrong-km", "2026-03-11", { km: 3 }),
      run("near-right-km", "2026-03-11", { km: 8.2 }),
    ];
    expect(candidateRuns(planOf([session]), session, runs).map(r => r.id))
      .toEqual(["near-right-km", "near-wrong-km", "far-day"]);
  });

  it("stops at the window", () => {
    const inside = run("in", "2026-03-09");   // 3 days before
    const outside = run("out", "2026-03-08"); // 4 days before
    expect(MATCH_WINDOW_DAYS).toBe(3);
    expect(candidateRuns(planOf([session]), session, [inside, outside]).map(r => r.id)).toEqual(["in"]);
  });

  // One run settles one session — otherwise the same Wednesday run could tick
  // off every easy day in the week.
  it("never offers a run another session already claims", () => {
    const other = sess("w3d1", "2026-03-10", { done: true, runId: "a" });
    const runs = [run("a", "2026-03-11"), run("b", "2026-03-11")];
    expect(candidateRuns(planOf([other, session]), session, runs).map(r => r.id)).toEqual(["b"]);
  });

  // The running / cross-training line: a bike ride is not a tempo.
  it("keeps cross-training and running apart, both ways", () => {
    const bikeRun = run("bike", "2026-03-12", { type: "OTHER", km: 0 });
    const legs = run("legs", "2026-03-12");
    expect(candidateRuns(planOf([session]), session, [bikeRun, legs]).map(r => r.id)).toEqual(["legs"]);
    const bikeSess = sess("w3d5", "2026-03-12", { type: "OTHER", km: 0 });
    expect(candidateRuns(planOf([bikeSess]), bikeSess, [bikeRun, legs]).map(r => r.id)).toEqual(["bike"]);
  });

  it("has nothing to offer for a session already settled", () => {
    const done = sess("w3d3", "2026-03-12", { done: true });
    expect(candidateRuns(planOf([done]), done, [run("a", "2026-03-12")])).toEqual([]);
    const skipped = sess("w3d3", "2026-03-12", { skipped: true });
    expect(candidateRuns(planOf([skipped]), skipped, [run("a", "2026-03-12")])).toEqual([]);
  });
});

describe("bestSessionForRun", () => {
  it("prefers the same day over a nearby one", () => {
    const plan = planOf([sess("w3d1", "2026-03-10"), sess("w3d3", "2026-03-11")]);
    expect(bestSessionForRun(plan, run("a", "2026-03-11"))?.id).toBe("w3d3");
  });

  it("reaches the next day's session when nothing is scheduled today", () => {
    const plan = planOf([sess("w3d3", "2026-03-12", { type: "TEMPO" })]);
    const match = bestSessionForRun(plan, run("a", "2026-03-11"));
    expect(match?.id).toBe("w3d3");
    expect(match?.wNum).toBe(3);
  });

  it("breaks a day-gap tie on the closer distance", () => {
    const plan = planOf([
      sess("short", "2026-03-11", { km: 5 }),
      sess("long", "2026-03-11", { km: 12 }),
    ]);
    expect(bestSessionForRun(plan, run("a", "2026-03-11", { km: 11.6 }))?.id).toBe("long");
  });

  it("never offers a race", () => {
    const plan = planOf([sess("race", "2026-03-11", { type: "RACE" })]);
    expect(bestSessionForRun(plan, run("a", "2026-03-11"))).toBeNull();
  });

  it("declines a run that already settled a session", () => {
    const plan = planOf([sess("w3d1", "2026-03-10", { done: true, runId: "a" }), sess("w3d3", "2026-03-11")]);
    expect(bestSessionForRun(plan, run("a", "2026-03-11"))).toBeNull();
  });

  it("has nothing to say without a plan or a date", () => {
    expect(bestSessionForRun(null, run("a", "2026-03-11"))).toBeNull();
    expect(bestSessionForRun(planOf([sess("w3d3", "2026-03-11")]), { id: "a" })).toBeNull();
  });
});

describe("claimedRunIds", () => {
  it("collects every run a session points at", () => {
    const plan = planOf([sess("a", "2026-03-10", { runId: "r1" }), sess("b", "2026-03-11", { runId: null })]);
    expect([...claimedRunIds(plan)]).toEqual(["r1"]);
    expect(claimedRunIds(null).size).toBe(0);
  });
});

// A week owns [startDate, startDate + 7). Re-dating a session outside that span
// would file it under a week it no longer falls in.
describe("canMoveSessionTo", () => {
  const plan = planOf([sess("w3d3", "2026-03-12")], "2026-03-09");

  it("allows any day inside the session's own week", () => {
    expect(canMoveSessionTo(plan, 3, "2026-03-09")).toBe(true);
    expect(canMoveSessionTo(plan, 3, "2026-03-15")).toBe(true);
  });

  it("refuses either side of it", () => {
    expect(canMoveSessionTo(plan, 3, "2026-03-08")).toBe(false);
    expect(canMoveSessionTo(plan, 3, "2026-03-16")).toBe(false);
  });

  it("refuses an unknown week", () => {
    expect(canMoveSessionTo(plan, 9, "2026-03-10")).toBe(false);
    expect(canMoveSessionTo(null, 3, "2026-03-10")).toBe(false);
  });
});
