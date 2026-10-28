import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { buildPlan } from "./plan";
import { buildOpenPlan } from "./openPlan";
import { BLOCK_DONE_DAYS, blockRecap, finishedBlock } from "./blockRecap";
import { ymd } from "./format";
import type { Plan, Run, SettingsState } from "../types";
import type { PlanSessionInput } from "./plan";

const TODAY = "2026-10-20";
const day = (n: number, from = TODAY) => ymd(new Date(new Date(from + "T00:00:00").getTime() + n * 86400000));
const SESSIONS: PlanSessionInput[] = [{ dayOffset: 2, minutes: 45 }, { dayOffset: 6, minutes: 90 }];

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-17T09:00:00")); });
afterEach(() => vi.useRealTimers());

const raceDate = "2026-10-04";
const racePlan = () => buildPlan(raceDate, 3000, SESSIONS, 10, 0, { recovery: true }) as unknown as Plan;
const run = (id: string, date: string, km: number, extra: Partial<Run> = {}) => ({ id, date, type: "EASY", km, durationSec: km * 330, ...extra }) as Run;

describe("blockRecap", () => {
  it("covers the block up to the day before the race and leaves the race run out", () => {
    const plan = racePlan();
    const done = plan.weeks.flatMap(w => w.sessions).filter(s => s.type !== "RACE" && s.date < raceDate).slice(0, 4);
    for (const s of done) s.done = true;
    const runs = [run("a", day(-30, raceDate), 8), run("b", day(-9, raceDate), 12), run("c", day(-2, raceDate), 5),
      run("race", raceDate, 10, { type: "RACE" }), run("after", day(2, raceDate), 4)];
    const r = blockRecap({ plan, runs, today: day(8, raceDate), race: { date: raceDate, runId: "race" } })!;
    expect(r.sessionsDone).toBe(4);
    expect(r.sessionsPlanned).toBeGreaterThan(4);
    expect(r.km).toBe(25);
    expect(r.longestKm).toBe(12);
    expect(r.runs).toBe(3);
    expect(r.to).toBe(day(-1, raceDate));
  });

  it("an open plan's recap is its last four weeks", () => {
    vi.setSystemTime(new Date("2026-09-16T09:00:00"));
    const plan = buildOpenPlan({ planSessions: SESSIONS } as unknown as SettingsState, { target: "healthy", distanceKm: 10 }, { runs: [] });
    const today = day(40, plan.goal!.startDate as string);
    const r = blockRecap({ plan, runs: [run("x", day(-3, today), 6), run("old", day(-40, today), 20)], today })!;
    expect(r.from).toBe(day(-28, today));
    expect(r.km).toBe(6);
  });

  it("is null with no plan, or nothing in it", () => {
    expect(blockRecap({ plan: null, runs: [], today: TODAY })).toBeNull();
    expect(blockRecap({ plan: racePlan(), runs: [], today: "2026-08-01" })).toBeNull();
  });

  it("cross-training is not distance run", () => {
    const plan = racePlan();
    const r = blockRecap({ plan, runs: [run("bike", day(-5, raceDate), 30, { type: "OTHER" }), run("run", day(-4, raceDate), 5)], today: day(3, raceDate),
      race: { date: raceDate } })!;
    expect(r.km).toBe(5);
  });
});

// A Monday anchor puts the race in an extra week, a midweek one in the n-th.
describe.each(["2026-06-15", "2026-06-17"])("easy pace trend (plan built %s)", (anchor) => {
  // buildPlan reads the clock, so the plan is built under the pinned one.
  let plan: Plan;
  let lead: Plan["weeks"];
  let taper: Plan["weeks"];
  let early: string;
  let late: string;
  beforeAll(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(anchor + "T09:00:00"));
    plan = racePlan();
    vi.useRealTimers();
    lead = plan.weeks.filter(w => w.phase !== "TAPER" && w.phase !== "RACE" && w.phase !== "RECOVERY");
    taper = plan.weeks.filter(w => w.phase === "TAPER");
    early = lead[0].startDate as string;
    late = lead[lead.length - 1].startDate as string;
  });
  const today = day(2, raceDate);
  const HR_SETTINGS = { maxHR: 190, restHR: 50 };
  // `n` easy runs, one per day from the week's start, 10 km at `pace` s/km.
  const easyRuns = (weekStart: string, n: number, pace: number, extra: Partial<Run> = {}, tag = "") =>
    Array.from({ length: n }, (_, i) => run(`${tag}${weekStart}-${i}`, day(i, weekStart), 10, { durationSec: 10 * pace, ...extra }));
  const recap = (runs: Run[], settings?: Parameters<typeof blockRecap>[0]["settings"]) =>
    blockRecap({ plan, runs, today, race: { date: raceDate }, settings })!;

  it("has enough weeks to split", () => {
    expect(lead.length).toBeGreaterThanOrEqual(4);
    expect(taper.length).toBeGreaterThan(0);
  });

  it("without heart rate it is the median easy pace at each end, with no HR claim", () => {
    const r = recap([...easyRuns(early, 3, 360), ...easyRuns(late, 3, 340)]);
    expect(r.easyPace).toEqual({ from: 360, to: 340, atHr: null });
  });

  it("hides the line when either end has fewer than three easy runs", () => {
    expect(recap([...easyRuns(early, 2, 360), ...easyRuns(late, 3, 340)]).easyPace).toBeNull();
    expect(recap([...easyRuns(early, 3, 360), ...easyRuns(late, 2, 340)]).easyPace).toBeNull();
    expect(recap([]).easyPace).toBeNull();
  });

  it("leaves out the taper and every run that is not easy", () => {
    const quick = easyRuns(taper[0].startDate as string, 4, 300);
    const tempo = easyRuns(late, 4, 250, { type: "TEMPO" }, "t");
    const r = recap([...easyRuns(early, 3, 360), ...easyRuns(late, 3, 340), ...quick, ...tempo]);
    expect(r.easyPace).toEqual({ from: 360, to: 340, atHr: null });
    expect(recap([...easyRuns(early, 3, 360), ...quick, ...tempo]).easyPace).toBeNull();
  });

  it("with heart rate it moves every run to the block's median HR on the prior slope", () => {
    // Same pace, lower HR at the end = faster at the same effort.
    const runs = [...easyRuns(early, 3, 360, { hr: 150 }), ...easyRuns(late, 3, 360, { hr: 140 })];
    // slope = -1.4 x 360 / 140 = -3.6 s/km per bpm; median HR 145.
    expect(recap(runs, HR_SETTINGS).easyPace).toEqual({ from: 378, to: 342, atHr: 145 });
    // Without a profile the same runs make only the plain median, never an HR claim.
    expect(recap(runs).easyPace).toEqual({ from: 360, to: 360, atHr: null });
  });

  it("a harder run is not fitness: a faster late pace at a higher HR reads about flat", () => {
    const runs = [...easyRuns(early, 3, 360, { hr: 140 }), ...easyRuns(late, 3, 342, { hr: 145 })];
    const p = recap(runs, HR_SETTINGS).easyPace!;
    expect(Math.abs(p.from - p.to)).toBeLessThanOrEqual(1);
  });

  it("falls back to the plain median when too few runs carry a heart rate", () => {
    const runs = [...easyRuns(early, 2, 360, { hr: 150 }), ...easyRuns(early, 1, 360, {}, "n"), ...easyRuns(late, 3, 340, { hr: 140 })];
    expect(recap(runs, HR_SETTINGS).easyPace).toEqual({ from: 360, to: 340, atHr: null });
  });

  it("an open block's four weeks split in two", () => {
    vi.setSystemTime(new Date("2026-09-16T09:00:00"));
    const open = buildOpenPlan({ planSessions: SESSIONS } as unknown as SettingsState, { target: "healthy", distanceKm: 10 }, { runs: [] });
    const t = day(40, open.goal!.startDate as string);
    const from = day(-28, t);
    const runs = [...easyRuns(from, 3, 380, {}, "a"), ...easyRuns(day(-9, t), 3, 360, {}, "b")];
    expect(blockRecap({ plan: open, runs, today: t })!.easyPace).toEqual({ from: 380, to: 360, atHr: null });
  });
});

describe("finishedBlock", () => {
  const settings = { planSessions: SESSIONS } as unknown as SettingsState;
  const open = () => {
    vi.setSystemTime(new Date("2026-09-16T09:00:00"));
    return buildOpenPlan(settings, { target: "healthy", distanceKm: 10 }, { runs: [] });
  };
  const checkpoints = (plan: Plan) => plan.weeks.flatMap(w => w.sessions).filter(s => s.sd?.kind === "checkpoint");

  it("is the block whose checkpoint run is done, for a few days after it", () => {
    const plan = open();
    const [first] = checkpoints(plan);
    expect(finishedBlock(plan, first.date)).toBeNull();
    first.done = true;
    const start = plan.goal!.startDate as string;
    expect(finishedBlock(plan, day(1, first.date))).toEqual({ block: 1, from: start, to: day(27, start) });
    expect(finishedBlock(plan, day(BLOCK_DONE_DAYS, first.date))?.block).toBe(1);
    expect(finishedBlock(plan, day(BLOCK_DONE_DAYS + 1, first.date))).toBeNull();
  });

  it("numbers a later block by the calendar", () => {
    const plan = open();
    const second = checkpoints(plan)[1];
    if (!second) return; // a first build holds one block
    second.done = true;
    expect(finishedBlock(plan, second.date)?.block).toBe(2);
  });

  it("is null for a race plan", () => {
    expect(finishedBlock(racePlan(), TODAY)).toBeNull();
  });
});
