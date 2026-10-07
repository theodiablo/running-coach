import { describe, expect, it } from "vitest";
import type { Plan, Run } from "../types";
import { ymd } from "./format";
import { STRETCH_LOG_CAP, appendStretchLog, stretchSuggestion, stretchesThisWeek } from "./stretchSuggest";
import type { StretchLogEntry } from "./stretchSuggest";

// A Wednesday evening; every date below is derived from it.
const NOW = new Date(2026, 9, 7, 19, 0, 0);
const TODAY = ymd(NOW);
const dayOffset = (n: number) => { const d = new Date(NOW); d.setDate(d.getDate() + n); return ymd(d); };
const YESTERDAY = dayOffset(-1);

const run = (over: Partial<Run>): Run => ({ id: "r", date: TODAY, type: "EASY", km: 10, durationSec: 3000, ...over });
const logAt = (at: Date, routine: StretchLogEntry["routine"] = "cooldown"): StretchLogEntry =>
  ({ date: ymd(at), at: at.getTime(), routine, sec: 420 });
const planWith = (type: string, date = TODAY): Plan =>
  ({ weeks: [{ weekNumber: 1, startDate: date, phase: "base", sessions: [{ id: "s", date, type, desc: "", km: 6, pace: 300 }] }] } as unknown as Plan);

const suggest = (runs: Run[], extra: Partial<Parameters<typeof stretchSuggestion>[0]> = {}) =>
  stretchSuggestion({ runs, plan: null, log: [], now: NOW, ...extra });

describe("stretchSuggestion: after a run today", () => {
  it("offers the cool-down", () => {
    expect(suggest([run({})])).toEqual({ routine: "cooldown", focus: "standard", km: 10 });
  });

  it("ignores a short run and cross-training", () => {
    expect(suggest([run({ durationSec: 600 })])).toBeNull();
    expect(suggest([run({ type: "OTHER", km: 0 })])).toBeNull();
  });

  it("puts calves first after a hilly run", () => {
    expect(suggest([run({ elevation: 200 })])).toMatchObject({ focus: "hills" });
    expect(suggest([run({ elevation: 100 })])).toMatchObject({ focus: "standard" });
  });

  it("gives hips more time after a hard session", () => {
    expect(suggest([run({ type: "INTERVALS" })])).toMatchObject({ focus: "hard" });
  });

  it("is spent by a stretch after the run, not by one before it", () => {
    const startedAt = new Date(NOW.getTime() - 2 * 3600e3).toISOString();
    const r = run({ startedAt, durationSec: 3000 });
    const before = logAt(new Date(NOW.getTime() - 3 * 3600e3));
    const after = logAt(new Date(NOW.getTime() - 30 * 60e3));
    expect(suggest([r], { log: [before] })).not.toBeNull();
    expect(suggest([r], { log: [after] })).toBeNull();
  });

  it("treats any stretch today as enough for a hand-logged run with no start time", () => {
    expect(suggest([run({})], { log: [logAt(new Date(NOW.getTime() - 8 * 3600e3))] })).toBeNull();
  });

  it("adds up the day's distance", () => {
    expect(suggest([run({ km: 5 }), run({ km: 4, id: "r2" })])).toMatchObject({ km: 9 });
  });
});

describe("stretchSuggestion: the day after a big run", () => {
  it("offers recovery after yesterday's long run", () => {
    expect(suggest([run({ date: YESTERDAY, type: "LONG", km: 18 })])).toEqual({ routine: "recovery", km: 18, race: false });
  });

  it("counts a 90-minute run and a race as big", () => {
    expect(suggest([run({ date: YESTERDAY, durationSec: 95 * 60 })])).toMatchObject({ routine: "recovery" });
    expect(suggest([run({ date: YESTERDAY, type: "RACE", km: 21.1 })])).toMatchObject({ race: true });
  });

  it("stays quiet after an ordinary run yesterday", () => {
    expect(suggest([run({ date: YESTERDAY })])).toBeNull();
  });

  it("stays quiet when a hard session is planned today", () => {
    expect(suggest([run({ date: YESTERDAY, type: "LONG" })], { plan: planWith("TEMPO") })).toBeNull();
    expect(suggest([run({ date: YESTERDAY, type: "LONG" })], { plan: planWith("EASY") })).toMatchObject({ routine: "recovery" });
  });

  it("gives way to a run today", () => {
    expect(suggest([run({}), run({ date: YESTERDAY, type: "LONG", id: "y" })])).toMatchObject({ routine: "cooldown" });
  });
});

describe("stretchSuggestion: off switches", () => {
  it("respects the setting and a 'not today'", () => {
    expect(suggest([run({})], { enabled: false })).toBeNull();
    expect(suggest([run({})], { dismissedOn: TODAY })).toBeNull();
    expect(suggest([run({})], { dismissedOn: YESTERDAY })).not.toBeNull();
  });
});

describe("stretch log", () => {
  it("counts the sessions since Monday", () => {
    const monday = new Date(2026, 9, 5, 8);
    const lastSunday = new Date(2026, 9, 4, 8);
    expect(stretchesThisWeek([logAt(lastSunday), logAt(monday), logAt(NOW)], NOW)).toBe(2);
  });

  it("keeps only the newest entries", () => {
    let log: StretchLogEntry[] = [];
    for (let i = 0; i < STRETCH_LOG_CAP + 5; i++) log = appendStretchLog(log, { ...logAt(NOW), at: i });
    expect(log).toHaveLength(STRETCH_LOG_CAP);
    expect(log[0].at).toBe(5);
  });
});
