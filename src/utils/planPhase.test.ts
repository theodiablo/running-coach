import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildPlan, carryProgress } from "./plan";
import { planPhase, mainRace, RACE_WEEK_DAYS, DEBRIEF_ASK_DAYS, DEBRIEF_RESULT_DAYS } from "./planPhase";
import { ymd } from "./format";
import type { Participation, Plan, Run, SettingsState } from "../types";

// buildPlan anchors week 1 on the next Monday, so the clock is pinned and both
// alignments run: a Monday anchor puts the race in an extra week, a midweek one
// in the n-th. Every date is derived from the anchor or read off the plan.
const ANCHORS: [string, string][] = [
  ["monday anchor", "2026-09-14"],
  ["midweek anchor", "2026-09-16"],
];

const dayAfter = (from: string, days: number) =>
  ymd(new Date(new Date(from + "T00:00:00").getTime() + days * 86400000));

const SESSIONS = [{ dayOffset: 2, minutes: 45 }, { dayOffset: 6, minutes: 90 }];

const build = (raceDate: string, mainEditionId: string | null = null) =>
  buildPlan(raceDate, 3000, SESSIONS, 10, 0, { style: "balanced", mainEditionId }) as unknown as Plan;

const settingsFor = (raceDate: string, targetEditionId: string | null = null) =>
  ({ raceDate, distanceKm: 10, goalSec: 3000, targetEditionId, planSessions: SESSIONS }) as unknown as SettingsState;

const run = (id: string, date: string, extra: Partial<Run> = {}) =>
  ({ id, date, type: "RACE", km: 10, durationSec: 2900, effort: null, ...extra }) as Run;

// Settle the plan's RACE session the way the hub does.
const withRaceSession = (plan: Plan, patch: Record<string, unknown>): Plan => ({
  ...plan,
  weeks: plan.weeks.map(w => ({ ...w, sessions: w.sessions.map(s => s.id === "race" ? { ...s, ...patch } : s) })),
});

describe.each(ANCHORS)("planPhase (%s)", (_label, anchor) => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(anchor + "T09:00:00")); });
  afterEach(() => vi.useRealTimers());

  const raceDate = dayAfter(anchor, 84);
  const at = (k: number) => dayAfter(raceDate, k);
  const input = (over: Record<string, unknown> = {}) => ({
    plan: build(raceDate), settings: settingsFor(raceDate), participations: [] as Participation[], runs: [] as Run[], ...over,
  });

  it("is null with no plan", () => {
    expect(planPhase(input({ plan: null }), at(0))).toBeNull();
  });

  it("reads the main race off the plan's own RACE session", () => {
    const race = mainRace(build(raceDate));
    expect(race?.date).toBe(raceDate);
    expect(race?.sId).toBe("race");
    expect(race?.km).toBe(10);
  });

  it.each([
    [-(RACE_WEEK_DAYS + 1), "active"],
    [-RACE_WEEK_DAYS, "raceWeek"],
    [-(RACE_WEEK_DAYS - 1), "raceWeek"],
    [-1, "raceWeek"],
    [0, "raceWeek"],
    [1, "debrief"],
    [DEBRIEF_ASK_DAYS, "debrief"],
    [DEBRIEF_ASK_DAYS + 1, "choosing"],
  ])("unsettled, %i days from the race: %s", (k, phase) => {
    const info = planPhase(input(), at(k));
    expect(info?.phase).toBe(phase);
    expect(info?.daysSince).toBe(k);
    expect(info?.debrief).toBe(phase === "debrief" ? "ask" : undefined);
  });

  it("asks for the race only once the day is over", () => {
    expect(planPhase(input(), at(0))?.debrief).toBeUndefined();
    expect(planPhase(input(), at(1))?.debrief).toBe("ask");
  });

  describe("settled done", () => {
    const plan = withRaceSession(build(raceDate), { done: true, runId: "r1" });
    const runs = [run("r1", raceDate)];

    it.each([
      [0, "debrief"],
      [1, "debrief"],
      [DEBRIEF_RESULT_DAYS, "debrief"],
      [DEBRIEF_RESULT_DAYS + 1, "choosing"],
      [DEBRIEF_ASK_DAYS + 5, "choosing"],
    ])("run without an effort, %i days after: %s", (k, phase) => {
      const info = planPhase(input({ plan, runs }), at(k));
      expect(info?.phase).toBe(phase);
      expect(info?.debrief).toBe(phase === "debrief" ? "result" : undefined);
      expect(info?.settled).toBe("done");
      expect(info?.raceRunId).toBe("r1");
      expect(info?.resultSec).toBe(2900);
    });

    it("moves on once the effort is answered", () => {
      expect(planPhase(input({ plan, runs: [run("r1", raceDate, { effort: 6 })] }), at(1))?.phase).toBe("choosing");
    });

    it("has no result question without a run behind the tick", () => {
      const ticked = withRaceSession(build(raceDate), { done: true });
      expect(planPhase(input({ plan: ticked }), at(1))?.phase).toBe("choosing");
    });

    it("is not a result before the race has happened", () => {
      expect(planPhase(input({ plan, runs }), at(-3))?.phase).toBe("raceWeek");
    });
  });

  it("goes straight to choosing when the race session was skipped", () => {
    const plan = withRaceSession(build(raceDate), { skipped: true });
    for (const k of [-20, 0, 1, 5])
      expect(planPhase(input({ plan }), at(k))).toMatchObject({ phase: "choosing", settled: "skipped" });
  });

  describe("participation-only settlement (detection used to tick nothing else)", () => {
    const edition = "ed-1";
    const part = (over: Partial<Participation>) =>
      ({ editionId: edition, status: "done", timeSec: 2950, runId: "r1", ...over }) as Participation;
    const base = (over: Record<string, unknown> = {}) =>
      input({ plan: build(raceDate, edition), settings: settingsFor(raceDate, edition), ...over });

    it("a done participation settles the race and prefers its own time", () => {
      const info = planPhase(base({ participations: [part({})], runs: [run("r1", raceDate)] }), at(1));
      expect(info).toMatchObject({ phase: "debrief", debrief: "result", settled: "done", resultSec: 2950 });
    });

    it("a skipped participation settles it as not run", () => {
      expect(planPhase(base({ participations: [part({ status: "skipped", timeSec: null, runId: null })] }), at(1)))
        .toMatchObject({ phase: "choosing", settled: "skipped" });
    });

    it("a wishlist participation settles nothing", () => {
      expect(planPhase(base({ participations: [part({ status: "wishlist" })] }), at(1))?.debrief).toBe("ask");
    });
  });

  describe("which races are catalogue races", () => {
    it("via the session's own editionId", () => {
      expect(planPhase(input({ plan: build(raceDate, "ed-1") }), at(1))?.race.editionId).toBe("ed-1");
    });

    it("via settings.targetEditionId alone (onboarding builds without mainEditionId)", () => {
      const info = planPhase(input({ settings: settingsFor(raceDate, "ed-2") }), at(1));
      expect(info?.race.editionId).toBe("ed-2");
      expect(info?.catalogue).toBe(true);
    });

    it("not when the target is for a different date", () => {
      const info = planPhase(input({ settings: settingsFor(dayAfter(raceDate, 7), "ed-2") }), at(1));
      expect(info?.catalogue).toBe(false);
    });

    it("a hand-entered race is neutral", () => {
      const info = planPhase(input(), at(1));
      expect(info?.race.editionId).toBeNull();
      expect(info?.catalogue).toBe(false);
    });
  });

  it("a rebuild after the race is active again, and the carried race is history", () => {
    const old = withRaceSession(build(raceDate), { done: true, runId: "r1" });
    const after = at(10);
    vi.setSystemTime(new Date(after + "T09:00:00"));
    const nextRace = dayAfter(after, 84);
    const rebuilt = carryProgress(old, build(nextRace), "rebuild");
    expect(rebuilt.weeks.some(w => w.sessions.some(s => s.id === "past-race"))).toBe(true);
    const info = planPhase(input({ plan: rebuilt, settings: settingsFor(nextRace), runs: [run("r1", raceDate)] }), after);
    expect(info?.phase).toBe("active");
    expect(info?.race.date).toBe(nextRace);
    expect(info?.settled).toBeNull();
  });

  it("falls back to the RACE session dated plan.raceDate when no session is id'd race", () => {
    const plan = build(raceDate);
    const renamed = { ...plan, weeks: plan.weeks.map(w => ({ ...w, sessions: w.sessions.map(s => s.id === "race" ? { ...s, id: "x-race" } : s) })) };
    expect(mainRace(renamed)?.sId).toBe("x-race");
  });
});
