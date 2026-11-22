import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cardStyles, numberModel, routeModel, statsFor, weekModel, headlineEffort } from "./cardModel";
import type { CardInput } from "./cardModel";
import { buildPlan } from "../utils/plan";
import { addDays } from "../utils/format";
import type { Plan, PlanSession, Run, SettingsState } from "../types";

const settings = { raceDate: "", goalSec: "", distanceKm: "", raceElevation: 0, name: "" } as unknown as SettingsState;

const input = (over: Partial<CardInput> = {}): CardInput => ({
  run: { id: "r", date: "2026-11-20", type: "EASY", km: 10.4, durationSec: 3138 },
  runs: [], plan: null, settings, participations: [], today: "2026-11-20", hasRoute: false, ...over,
});

const prior10k = (sec: number, date = "2026-03-01"): Run => ({ id: "p" + sec, date, type: "EASY", km: 10, durationSec: sec, bestEfforts: { "10k": sec } });

// A hand-written race plan whose dates all derive from `monday`.
function racePlan(monday: string, opts: { doneToday?: boolean } = {}): Plan {
  const weeks = Array.from({ length: 4 }, (_, i) => {
    const start = addDays(monday, (i - 1) * 7);
    const sessions: PlanSession[] = [
      { id: `w${i}e`, date: addDays(start, 1), type: "EASY", desc: "", km: 6, pace: 360 },
      { id: `w${i}l`, date: addDays(start, 5), type: "LONG", desc: "", km: 12, pace: 380 },
    ];
    if (i === 3) sessions.push({ id: "race", date: addDays(start, 6), type: "RACE", desc: "", km: 21.1, pace: 300 });
    return { weekNumber: i + 1, startDate: start, phase: "BUILD", sessions };
  });
  if (opts.doneToday) weeks[1].sessions[0] = { ...weeks[1].sessions[0], done: true, runId: "r" };
  return { raceDate: weeks[3].sessions[2].date, weeks } as Plan;
}

describe("cardStyles: the pre-selection rule", () => {
  it("a personal best pre-selects Number", () => {
    const run: Run = { id: "r", date: "2026-11-20", type: "EASY", km: 10, durationSec: 2900, bestEfforts: { "10k": 2900 } };
    expect(cardStyles(input({ run, runs: [prior10k(3000)], hasRoute: true })).preselected).toBe("number");
  });

  it("a first effort is not a best: a run with a trace pre-selects Route", () => {
    const run: Run = { id: "r", date: "2026-11-20", type: "EASY", km: 10, durationSec: 2900, bestEfforts: { "10k": 2900 } };
    expect(headlineEffort(run, [])?.kind).toBe("first");
    expect(cardStyles(input({ run, hasRoute: true })).preselected).toBe("route");
  });

  it("a run that settled a session this week pre-selects Week", () => {
    const monday = "2026-11-16";
    const run: Run = { id: "r", date: addDays(monday, 1), type: "EASY", km: 6, durationSec: 2100 };
    const plan = racePlan(monday, { doneToday: true });
    const res = cardStyles(input({ run, plan, today: addDays(monday, 1), hasRoute: true }));
    expect(res.offered).toEqual(["route", "number", "week"]);
    expect(res.preselected).toBe("week");
  });

  it("the finish screen's session counts as settled", () => {
    const monday = "2026-11-16";
    const plan = racePlan(monday);
    const run: Run = { date: addDays(monday, 1), type: "EASY", km: 6, durationSec: 2100 };
    expect(cardStyles(input({ run, plan, today: run.date, session: plan.weeks[1].sessions[0] })).preselected).toBe("week");
  });

  it("an unlinked run in the current week offers Week but never pre-selects it", () => {
    const monday = "2026-11-16";
    const run: Run = { id: "x", date: addDays(monday, 2), type: "EASY", km: 6, durationSec: 2100 };
    const res = cardStyles(input({ run, plan: racePlan(monday), today: run.date, hasRoute: true }));
    expect(res.offered).toContain("week");
    expect(res.preselected).toBe("route");
  });

  it("a run from an earlier week is not offered Week", () => {
    const monday = "2026-11-16";
    const run: Run = { id: "r", date: addDays(monday, -6), type: "EASY", km: 6, durationSec: 2100 };
    const res = cardStyles(input({ run, plan: racePlan(monday), today: addDays(monday, 1) }));
    expect(res.offered).toEqual(["number"]);
  });

  it("after the race (debrief/recovery) Week isn't offered", () => {
    const monday = "2026-11-16";
    const plan = racePlan(monday);
    const raceDay = plan.weeks[3].sessions[2].date;
    const run: Run = { id: "r", date: addDays(raceDay, 1), type: "EASY", km: 5, durationSec: 1800 };
    expect(cardStyles(input({ run, plan, today: addDays(raceDay, 1) })).offered).not.toContain("week");
  });

  it("no trace and no best: Number", () => {
    expect(cardStyles(input()).preselected).toBe("number");
  });

  it("an indoor session is Number, with no route", () => {
    const run: Run = { id: "i", date: "2026-11-20", type: "OTHER", km: 0, durationSec: 2700, activity: "bike" };
    expect(cardStyles(input({ run })).offered).toEqual(["number"]);
  });
});

describe("measured-only ranking", () => {
  it("an estimated rival neither counts as a beaten best nor as the previous best", () => {
    const run: Run = { id: "r", date: "2026-11-20", type: "EASY", km: 5.1, durationSec: 1530, bestEfforts: { "5k": 1500 } };
    // A manual 5K with no trace: its 5K is an estimate.
    const manual: Run = { id: "m", date: "2026-10-01", type: "EASY", km: 5, durationSec: 1600 };
    // Measured-only it is a "best" over nothing; the log still holds the manual 5K.
    expect(headlineEffort(run, [manual])).toBeNull();
  });

  it("a faster hand-logged effort rules out a best", () => {
    const run: Run = { id: "r", date: "2026-11-20", type: "EASY", km: 5.1, durationSec: 1530, bestEfforts: { "5k": 1500 } };
    const manualFaster: Run = { id: "m", date: "2026-10-01", type: "EASY", km: 5, durationSec: 1400 };
    const measuredSlower: Run = { id: "s", date: "2026-09-01", type: "EASY", km: 5, durationSec: 1700, bestEfforts: { "5k": 1650 } };
    expect(headlineEffort(run, [manualFaster, measuredSlower])).toBeNull();
  });

  it("the gain is measured against the last measured best", () => {
    const run: Run = { id: "r", date: "2026-11-20", type: "EASY", km: 5.1, durationSec: 1530, bestEfforts: { "5k": 1500 } };
    const manualSlower: Run = { id: "m", date: "2026-10-01", type: "EASY", km: 5, durationSec: 1560 };
    const measured: Run = { id: "s", date: "2026-09-01", type: "EASY", km: 5, durationSec: 1700, bestEfforts: { "5k": 1650 } };
    expect(numberModel(input({ run, runs: [manualSlower, measured] }), true).context).toEqual({ key: "shareCard.number.faster", vars: { delta: "2:30" } });
  });
});

describe("statsFor", () => {
  it("never shows distance or pace for a km:0 session", () => {
    const run: Run = { id: "i", date: "2026-11-20", type: "OTHER", km: 0, durationSec: 2700, hr: 132 };
    const stats = statsFor(run, true);
    expect(stats.map(s => s.label.key)).toEqual(["shareCard.stat.time", "shareCard.stat.hr"]);
  });

  it("drops pace when the switch is off", () => {
    expect(statsFor(input().run, false).map(s => s.label.key)).toEqual(["shareCard.stat.distance", "shareCard.stat.time"]);
    expect(statsFor(input().run, true)[2]).toMatchObject({ value: "5:02", unit: "/km" });
  });
});

describe("numberModel", () => {
  it("a PB headlines the effort with the gain over the last best", () => {
    const run: Run = { id: "r", date: "2026-11-20", type: "EASY", km: 10.4, durationSec: 3100, bestEfforts: { "10k": 2991 } };
    const m = numberModel(input({ run, runs: [prior10k(3029)] }), true);
    expect(m.tag?.key).toBe("shareCard.number.tagPb");
    expect(m.label?.key).toBe("bestEfforts.dist.10k");
    expect(m.figure).toBe("49:51");
    expect(m.context).toEqual({ key: "shareCard.number.faster", vars: { delta: "38 s" } });
  });

  it("without an effort, the distance", () => {
    const m = numberModel(input(), true);
    expect(m).toMatchObject({ tag: null, figure: "10.4", unit: "km" });
  });

  it("an indoor session headlines its time and activity", () => {
    const run: Run = { id: "i", date: "2026-11-20", type: "OTHER", km: 0, durationSec: 2700, activity: "bike" };
    expect(numberModel(input({ run }), true)).toMatchObject({ figure: "45:00", label: { key: "shareCard.activity.bike" } });
  });
});

describe("routeModel", () => {
  it("an estimated best is no claim: no pill, no best headline, not pre-selected as Number", () => {
    // Manual 10K, no trace: its 10K is the whole-run estimate.
    const run: Run = { id: "r", date: "2026-11-20", type: "EASY", km: 10, durationSec: 2900 };
    const m = routeModel(input({ run, runs: [prior10k(3000)] }), true);
    expect(m.headline.key).toMatch(/^shareCard\.head\.run\./);
    expect(m.pill).toBeNull();
    expect(numberModel(input({ run, runs: [prior10k(3000)] }), true).tag).toBeNull();
    expect(cardStyles(input({ run, runs: [prior10k(3000)], hasRoute: true })).preselected).toBe("route");
  });

  it("a measured best earns the pill", () => {
    const run: Run = { id: "r", date: "2026-11-20", type: "EASY", km: 10.4, durationSec: 3100, bestEfforts: { "10k": 2991 } };
    expect(routeModel(input({ run, runs: [prior10k(3029)] }), true).pill).toEqual({ dist: "bestEfforts.dist.10k", time: "49:51" });
  });

  it("the headline is stable per run", () => {
    expect(routeModel(input(), true).headline).toEqual(routeModel(input(), true).headline);
  });
});

describe("weekModel", () => {
  const monday = "2026-11-16";

  it("counts the week, keeps open days neutral and marks the run's day", () => {
    const plan = racePlan(monday, { doneToday: true });
    const run: Run = { id: "r", date: addDays(monday, 1), type: "EASY", km: 6, durationSec: 2100 };
    const m = weekModel(input({ run, plan, today: addDays(monday, 3), runs: [run] }))!;
    expect(m.header).toEqual({ kind: "race", title: null, daysToGo: 17 });
    expect([m.weekN, m.weekM]).toEqual([2, 4]);
    expect(m.days.map(d => d.state)).toEqual(["rest", "done", "rest", "rest", "rest", "open", "rest"]);
    expect(m.days[1].isRunDay).toBe(true);
    expect([m.done, m.planned, m.weekKm]).toEqual([1, 2, 6]);
    expect(m.runDay).toEqual({ today: false, weekday: 1 });
    expect(m.runType.key).toBe("common.types.EASY");
  });

  it("an unlinked run doesn't tick the day's planned session", () => {
    const plan = racePlan(monday);
    const run: Run = { id: "x", date: addDays(monday, 5), type: "EASY", km: 8, durationSec: 2800 };
    const m = weekModel(input({ run, plan, today: run.date }))!;
    expect(m.days[5]).toMatchObject({ state: "open", isRunDay: true });
    expect(m.done).toBe(0);
  });

  it("the finish screen's untyped run reads as 'my run'", () => {
    const plan = racePlan(monday);
    const run: Run = { date: addDays(monday, 2), type: "EASY", km: 5, durationSec: 1800 };
    expect(weekModel(input({ run, plan, today: run.date, session: null }))!.runType.key).toBe("shareCard.week.run");
  });
});

const ANCHORS: [string, string][] = [
  ["monday anchor", "2026-09-14"],
  ["midweek anchor", "2026-09-16"],
];

describe.each(ANCHORS)("weekModel on a built plan (%s)", (_label, anchor) => {
  beforeEach(() => { vi.setSystemTime(new Date(anchor + "T09:00:00")); });
  afterAll(() => { vi.useRealTimers(); });

  it("week n of m runs from the plan's own numbering up to the race week", () => {
    const raceDate = addDays(anchor, 10 * 7);
    const plan = buildPlan(raceDate, 6000, [{ dayOffset: 2, minutes: 45 }, { dayOffset: 6, minutes: 90 }], 21.0975, 0, { style: undefined });
    const race = plan.weeks.find(w => w.sessions.some(s => s.type === "RACE"))!;
    const week = plan.weeks[1];
    const sess = week.sessions[0];
    const today = sess.date;
    const run: Run = { id: "r", date: today, type: sess.type, km: 6, durationSec: 2100 };
    const done = { ...plan, weeks: plan.weeks.map(w => w === week ? { ...w, sessions: w.sessions.map(s => s === sess ? { ...s, done: true, runId: "r" } : s) } : w) };
    const m = weekModel(input({ run, plan: done, settings: { ...settings, raceDate }, today }))!;
    expect(m.weekN).toBe(week.weekNumber);
    expect(m.weekM).toBe(race.weekNumber);
    expect(m.header).toMatchObject({ kind: "race", daysToGo: Math.round((Date.parse(raceDate) - Date.parse(today)) / 86400000) });
    expect(m.runDay).toEqual({ today: true });
  });
});
