import { describe, expect, it } from "vitest";
import { goalSuggestions, paceChanges, predictRaceSec, roundGoal } from "./raceGoal";
import type { Plan, Run } from "../types";

const run = (date: string, km: number, durationSec: number, extra: Partial<Run> = {}) =>
  ({ id: date, date, type: "EASY", km, durationSec, ...extra }) as Run;

describe("predictRaceSec", () => {
  const today = "2026-11-16";
  it("projects the best recent effort with Riegel", () => {
    const sec = predictRaceSec([run("2026-11-01", 10, 3000)], 21.1, 0, today)!;
    expect(Math.round(sec)).toBe(Math.round(3000 * Math.pow(2.11, 1.06)));
  });
  it("adds the climb as flat-equivalent distance", () => {
    const flat = predictRaceSec([run("2026-11-01", 10, 3000)], 21.1, 0, today)!;
    expect(predictRaceSec([run("2026-11-01", 10, 3000)], 21.1, 500, today)!).toBeGreaterThan(flat);
  });
  it("ignores runs older than 12 weeks and cross-training", () => {
    expect(predictRaceSec([run("2026-08-01", 10, 3000)], 21.1, 0, today)).toBeNull();
    expect(predictRaceSec([run("2026-11-01", 0, 3000, { type: "OTHER" })], 21.1, 0, today)).toBeNull();
  });
});

describe("goal suggestions", () => {
  it("round to 5 s under an hour and 30 s above", () => {
    expect(roundGoal(1503)).toBe(1505);
    expect(roundGoal(13512)).toBe(13500);
  });
  it("offer a stretch, the prediction and a comfortable time", () => {
    expect(goalSuggestions(6000)).toEqual([
      { key: "stretch", sec: 5820 }, { key: "predicted", sec: 6000 }, { key: "comfortable", sec: 6300 },
    ]);
    expect(goalSuggestions(null)).toEqual([]);
  });
});

describe("paceChanges", () => {
  const plan = (race: number, easy: number, done = false) => ({ racePace: race, weeks: [{ sessions: [
    { id: "old", date: "2026-11-10", type: "EASY", pace: 999 },
    { id: "e", date: "2026-11-18", type: "EASY", pace: easy, done },
    { id: "l", date: "2026-11-22", type: "LONG", pace: 400 },
  ] }] }) as unknown as Plan;
  it("lists race pace and the next open session of each type that moves", () => {
    expect(paceChanges(plan(300, 380), plan(290, 370), "2026-11-16")).toEqual([
      { type: "RACE", before: 300, after: 290 }, { type: "EASY", before: 380, after: 370 },
    ]);
  });
  it("skips sessions already done and returns nothing without both plans", () => {
    expect(paceChanges(plan(300, 380, true), plan(300, 370, true), "2026-11-16")).toEqual([]);
    expect(paceChanges(null, plan(300, 380), "2026-11-16")).toEqual([]);
  });
});
