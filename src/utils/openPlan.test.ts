import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildPlan, carryProgress, extendOpenPlan, nextMondayYmd, planEndYmd } from "./plan";
import { STYLE_IDS } from "./planStyles";
import { validatePlan } from "./coachValidation";
import { renderSd } from "./sessionDesc";
import { cleanDesc, ymd } from "./format";
import {
  AUTO_START_DAYS, autoStartDue, buildOpenPlan, extendedOpenPlan, extensionDue, openSettingsPatch, raceKey,
} from "./openPlan";
import { resolveOpenPace } from "./openPace";
import { planPhase } from "./planPhase";
import type { OpenTarget, Plan, Run, SettingsState } from "../types";
import type { PlanSessionInput } from "./plan";

// buildPlan anchors week 1 on the next Monday, so the clock is pinned and both
// alignments run. Every date is derived from the anchor or read off the plan.
const ANCHORS: [string, string][] = [
  ["monday anchor", "2026-09-14"],
  ["midweek anchor", "2026-09-16"],
];

const DAYS_3: PlanSessionInput[] = [{ dayOffset: 1, minutes: 40 }, { dayOffset: 3, minutes: 45 }, { dayOffset: 6, minutes: 90 }];
const DAYS_4: PlanSessionInput[] = [
  { dayOffset: 0, minutes: 30 }, { dayOffset: 2, minutes: 45 }, { dayOffset: 4, minutes: 45 }, { dayOffset: 6, minutes: 90 },
];
const LAYOUTS: [string, PlanSessionInput[]][] = [["3 days", DAYS_3], ["4 days", DAYS_4]];
const TARGETS: OpenTarget[] = ["faster", "further", "healthy"];

const dayAfter = (from: string, days: number) => ymd(new Date(new Date(from + "T00:00:00").getTime() + days * 86400000));
const settingsFor = (planSessions: PlanSessionInput[], over: Record<string, unknown> = {}) =>
  ({ planSessions, planStyle: "balanced", trainingLevel: "occasional", goalSec: "", distanceKm: 10, raceDate: "", ...over }) as unknown as SettingsState;
const sessions = (p: Plan) => p.weeks.flatMap(w => w.sessions);

describe.each(ANCHORS)("open plans (%s)", (_label, anchor) => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(anchor + "T09:00:00")); });
  afterEach(() => vi.useRealTimers());

  const build = (settings: SettingsState, target: OpenTarget, light = false, runs: Run[] = []) =>
    buildOpenPlan(settings, { target, light, distanceKm: 10 }, { runs });

  describe.each(STYLE_IDS)("%s", style => {
    describe.each(LAYOUTS)("%s", (_l, layout) => {
      it.each(TARGETS)("%s builds two blocks that validate, each ending in a checkpoint", target => {
        const p = build(settingsFor(layout, { planStyle: style }), target);
        expect(validatePlan(p, { today: anchor }).errors).toEqual([]);
        expect(p.weeks).toHaveLength(8);
        expect(p.raceDate).toBe("");
        expect(p.weeks.every(w => w.phase === "BASE" || w.phase === "BUILD")).toBe(true);
        expect(sessions(p).some(s => s.type === "RACE")).toBe(false);
        // The 4th week of each block swaps its long run for the checkpoint.
        for (const i of [3, 7]) {
          const week = p.weeks[i];
          const cps = week.sessions.filter(s => s.sd?.kind === "checkpoint");
          expect(cps).toHaveLength(1);
          expect(cps[0].type).toBe(style === "runwalk" ? "WALK" : "EASY");
          expect(week.sessions.some(s => s.type === "LONG")).toBe(false);
          expect(renderSd(cps[0].sd, cps[0])).toBe(cleanDesc(cps[0].desc));
        }
        expect(sessions(p).filter(s => s.sd?.kind === "checkpoint")).toHaveLength(2);
        expect(sessions(p).some(s => s.sd?.kind === "checkpoint" && (s.type === "TEMPO" || s.type === "RACE"))).toBe(false);
      });

      it.each(TARGETS)("%s stays valid after two extensions", target => {
        let p = build(settingsFor(layout, { planStyle: style }), target);
        const s = settingsFor(layout, { planStyle: style });
        for (let k = 0; k < 2; k++) {
          const lastWeek = p.weeks[p.weeks.length - 1].startDate as string;
          vi.setSystemTime(new Date(dayAfter(lastWeek, -21) + "T09:00:00"));
          expect(extensionDue(p, ymd(new Date()))).toBe(true);
          const next = extendedOpenPlan(p, s, [], [], ymd(new Date()));
          expect(next).not.toBeNull();
          p = next!;
          expect(validatePlan(p, { today: ymd(new Date()) }).errors).toEqual([]);
        }
        const ids = sessions(p).map(x => x.id);
        expect(new Set(ids).size).toBe(ids.length);
        // Blocks line up: a checkpoint closes every 4th week, 4 blocks in all.
        p.weeks.forEach((w, i) => {
          expect(w.sessions.some(x => x.sd?.kind === "checkpoint")).toBe((i + 1) % 4 === 0);
        });
      });
    });
  });

  it("a lighter plan is about two easy runs a week", () => {
    const p = build(settingsFor(DAYS_4), "healthy", true);
    expect(validatePlan(p, { today: anchor }).errors).toEqual([]);
    expect(p.goal).toMatchObject({ kind: "open", target: "healthy", light: true, blockWeeks: 4 });
    for (const w of p.weeks) {
      expect(w.sessions).toHaveLength(2);
      expect(w.sessions.every(s => s.type === "EASY")).toBe(true);
    }
  });

  it("faster is the only target with quality sessions, in weeks 2 and 3 of a block", () => {
    const quality = (p: Plan) => p.weeks.map(w => w.sessions.some(s => s.type === "TEMPO" || s.type === "INTERVALS"));
    expect(quality(build(settingsFor(DAYS_3), "faster"))).toEqual([false, true, true, false, false, true, true, false]);
    expect(quality(build(settingsFor(DAYS_3), "further")).some(Boolean)).toBe(false);
    expect(quality(build(settingsFor(DAYS_3), "healthy")).some(Boolean)).toBe(false);
  });

  it("further grows its long run block over block", () => {
    const p = build(settingsFor(DAYS_3), "further");
    const longest = (i: number) => Math.max(...p.weeks[i].sessions.map(s => Number(s.km)));
    expect(longest(6)).toBeGreaterThan(longest(2));
  });

  it("starts on the next Monday and stamps the goal", () => {
    const p = build(settingsFor(DAYS_3), "faster");
    expect(p.weeks[0].startDate).toBe(nextMondayYmd());
    expect(p.goal).toMatchObject({ kind: "open", target: "faster", distanceKm: 10, startDate: nextMondayYmd(), paceSource: "suggested" });
  });

  it("a race inside the window lands on its week without ending the plan", () => {
    const date = dayAfter(nextMondayYmd(), 15);
    const p = buildOpenPlan(settingsFor(DAYS_3), { target: "healthy", distanceKm: 10 }, {
      runs: [], races: [{ editionId: "tune", date, distanceKm: 10 }],
    });
    expect(sessions(p).filter(s => s.type === "RACE").map(s => s.date)).toEqual([date]);
    expect(p.weeks).toHaveLength(8);
    expect(validatePlan(p, { today: anchor }).errors).toEqual([]);
  });

  it("opens inside the recovery of a race just run, without recovery after the blocks", () => {
    const raced = dayAfter(anchor, -2);
    const p = buildOpenPlan(settingsFor(DAYS_3), { target: "healthy", distanceKm: 10 }, {
      runs: [], afterRace: { date: raced, km: 21.1 },
    });
    expect(p.weeks[0].phase).toBe("RECOVERY");
    expect(p.weeks[p.weeks.length - 1].phase).not.toBe("RECOVERY");
    expect(p.recovery).toBeUndefined();
    expect(p.openedAfter).toBeDefined();
    expect(validatePlan(p, { today: anchor }).errors).toEqual([]);
  });

  it("a block plan is the same engine under another name", () => {
    const p = buildOpenPlan(settingsFor(DAYS_3), { kind: "block", target: "further", distanceKm: 5 }, { runs: [] });
    expect(p.goal).toMatchObject({ kind: "block", target: "further", distanceKm: 5 });
    expect(p.recovery).toBeUndefined();
    expect(p.weeks.some(w => w.phase === "RECOVERY")).toBe(false);
  });
});

describe("where an open plan's pace comes from", () => {
  const now = new Date("2026-09-16T09:00:00");
  const run = (date: string, km: number, durationSec: number, extra: Partial<Run> = {}) =>
    ({ id: date, date, type: "EASY", km, durationSec, ...extra }) as Run;

  it("the runner's own goal time wins", () => {
    expect(resolveOpenPace(3000, 10, [], now)).toEqual({ goalSec: 3000, source: "goal" });
  });

  it("else a recent effort projected to the plan's distance", () => {
    const r = resolveOpenPace("", 10, [run("2026-09-01", 10, 2700)], now);
    expect(r.source).toBe("anchor");
    expect(r.goalSec).toBe(2700);
    // A 5K at 25:00 projects (Riegel) to a bit over 52:00 for 10K.
    const five = resolveOpenPace("", 10, [run("2026-09-01", 5, 1500)], now);
    expect(five.source).toBe("anchor");
    expect(five.goalSec).toBeGreaterThan(3050);
    expect(five.goalSec).toBeLessThan(3200);
  });

  it("efforts older than eight weeks and cross-training don't count", () => {
    expect(resolveOpenPace("", 10, [run("2026-06-01", 10, 2700), run("2026-09-10", 10, 1800, { type: "OTHER" })], now).source).toBe("suggested");
  });

  it("else the mid-pack suggestion", () => {
    const r = resolveOpenPace("", 10, [], now);
    expect(r.source).toBe("suggested");
    expect(r.goalSec).toBeGreaterThan(0);
  });
});

describe("extendOpenPlan", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-16T09:00:00")); });
  afterEach(() => vi.useRealTimers());

  const base = () => buildOpenPlan(settingsFor(DAYS_3), { target: "healthy", distanceKm: 10 }, { runs: [] });

  it("is append-only: the runner's ticks and edits survive, ids stay unique", () => {
    const plan = base();
    const edited = structuredClone(plan);
    edited.weeks[6].sessions[0].km = 9.9;
    edited.weeks[0].sessions[0].done = true;
    edited.weeks[0].sessions[0].runId = "r1";
    vi.setSystemTime(new Date(dayAfter(plan.weeks[7].startDate as string, -14) + "T09:00:00"));
    const next = extendedOpenPlan(edited, settingsFor(DAYS_3), [], [], ymd(new Date()));
    expect(next).not.toBeNull();
    expect(next!.weeks.slice(0, 8)).toEqual(edited.weeks);
    expect(next!.weeks.length).toBeGreaterThan(8);
    const ids = sessions(next!).map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(next!.goal?.extendedThrough).toBe(dayAfter(next!.weeks[next!.weeks.length - 1].startDate as string, 6));
  });

  it("appends only weeks dated from the plan's end, renumbered after the last", () => {
    const plan = base();
    vi.setSystemTime(new Date(dayAfter(plan.weeks[7].startDate as string, -7) + "T09:00:00"));
    const built = buildPlan("", "", DAYS_3, 10, 0, { goal: { kind: "open", target: "healthy" }, blockOffset: 7 });
    const next = extendOpenPlan(plan, built);
    const end = planEndYmd(plan)!;
    const added = next.weeks.slice(plan.weeks.length);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every(w => (w.startDate as string) >= end)).toBe(true);
    expect(added.map(w => w.weekNumber)).toEqual(added.map((_, i) => plan.weeks.length + i + 1));
    for (const w of added) for (const s of w.sessions) expect(s.id).toMatch(new RegExp("^w" + w.weekNumber + "d\\d$"));
  });

  it("returns the plan untouched when `built` reaches no further", () => {
    const plan = base();
    expect(extendOpenPlan(plan, plan)).toBe(plan);
  });

  it("is idempotent through plan.goal.extendedThrough", () => {
    const plan = base();
    vi.setSystemTime(new Date(dayAfter(plan.weeks[7].startDate as string, -7) + "T09:00:00"));
    const today = ymd(new Date());
    expect(extensionDue(plan, today)).toBe(true);
    const next = extendedOpenPlan(plan, settingsFor(DAYS_3), [], [], today)!;
    expect(extensionDue(next, today)).toBe(false);
  });

  it("is not due before the last block, nor for a race plan", () => {
    const plan = base();
    expect(extensionDue(plan, ymd(new Date()))).toBe(false);
    expect(extensionDue(buildPlan("2026-12-20", 3000, DAYS_3, 10, 0, {}) as unknown as Plan, "2026-12-14")).toBe(false);
  });

  it("carryProgress keeps an open plan's history across a rebuild", () => {
    const plan = base();
    vi.setSystemTime(new Date(dayAfter(plan.weeks[3].startDate as string, 2) + "T09:00:00"));
    const rebuilt = carryProgress(plan, base(), "rebuild");
    expect(rebuilt.weeks.some(w => w.sessions.some(s => s.id.startsWith("past-")))).toBe(true);
    expect(rebuilt.goal?.startDate).toBe(nextMondayYmd());
  });
});

describe("planPhase for a plan with no race", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-16T09:00:00")); });
  afterEach(() => vi.useRealTimers());

  it("is `open` with the block and the next checkpoint", () => {
    const plan = buildOpenPlan(settingsFor(DAYS_3), { target: "faster", distanceKm: 10 }, { runs: [] });
    const start = plan.goal!.startDate as string;
    const info = (today: string) => planPhase({ plan, settings: settingsFor(DAYS_3), participations: [], runs: [] }, today);
    const cps = sessions(plan).filter(s => s.sd?.kind === "checkpoint").map(s => s.date);
    expect(info(start)).toMatchObject({ phase: "open", race: null, kind: "open", target: "faster", block: 1, checkpoint: cps[0] });
    expect(info(dayAfter(start, 30))).toMatchObject({ block: 2, checkpoint: cps[1] });
    expect(info(dayAfter(cps[1], 1))).toMatchObject({ checkpoint: null });
    expect(info(dayAfter(start, 56))).toMatchObject({ block: 3 });
  });

  it("a checkpoint already done is not the next one", () => {
    const plan = buildOpenPlan(settingsFor(DAYS_3), { target: "healthy", distanceKm: 10 }, { runs: [] });
    const first = sessions(plan).find(s => s.sd?.kind === "checkpoint")!;
    first.done = true;
    const info = planPhase({ plan, settings: settingsFor(DAYS_3), participations: [], runs: [] }, plan.goal!.startDate as string);
    expect(info && info.phase === "open" ? info.checkpoint : "x").toBe(sessions(plan).filter(s => s.sd?.kind === "checkpoint")[1].date);
  });
});

describe("automatic start for a runner who never answered", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-16T09:00:00")); });
  afterEach(() => vi.useRealTimers());

  const raceDate = "2026-10-04";
  const settings = (over: Record<string, unknown> = {}) => settingsFor(DAYS_3, { raceDate, distanceKm: 10, goalSec: 3000, ...over });
  // A race plan whose race has been settled and whose recovery has ended.
  const racePlan = () => {
    vi.setSystemTime(new Date("2026-08-17T09:00:00"));
    const p = buildPlan(raceDate, 3000, DAYS_3, 10, 0, { recovery: true }) as unknown as Plan;
    vi.setSystemTime(new Date("2026-09-16T09:00:00"));
    return { ...p, weeks: p.weeks.map(w => ({ ...w, sessions: w.sessions.map(s => s.id === "race" ? { ...s, done: true, runId: "race-run" } : s) })) } as Plan;
  };
  const until = () => racePlan().recovery!.until;
  const raceRun = { id: "race-run", date: raceDate, type: "RACE", km: 10, durationSec: 2900 } as Run;
  const easy = (date: string, extra: Partial<Run> = {}) => ({ id: "e" + date, date, type: "EASY", km: 5, durationSec: 1800, ...extra }) as Run;
  const due = (today: string, over: { runs?: Run[]; settings?: SettingsState; plan?: Plan } = {}) => autoStartDue({
    plan: over.plan ?? racePlan(), settings: over.settings ?? settings(), participations: [], runs: over.runs ?? [raceRun, easy(dayAfter(raceDate, 6))],
  }, today);

  it("starts AUTO_START_DAYS after the recovery ended, not before", () => {
    const u = until();
    expect(due(dayAfter(u, AUTO_START_DAYS - 1))).toBeNull();
    const hit = due(dayAfter(u, AUTO_START_DAYS));
    expect(hit).toMatchObject({ hadRuns: true, key: raceKey({ editionId: null, date: raceDate }) });
  });

  it("not without a run between race day and the end of the recovery", () => {
    const today = dayAfter(until(), 10);
    expect(due(today, { runs: [raceRun] })).toBeNull();
    // Cross-training, the race run itself and runs after the window don't count.
    expect(due(today, { runs: [raceRun, easy(dayAfter(raceDate, 3), { type: "OTHER" }), easy(dayAfter(until(), 2))] })).toBeNull();
  });

  it("not once the sheet was answered, nor once a plan was started for this race", () => {
    const today = dayAfter(until(), 10);
    const key = raceKey({ editionId: null, date: raceDate });
    expect(due(today, { settings: settings({ whatsNextFor: key }) })).toBeNull();
    const p = racePlan();
    expect(due(today, { plan: { ...p, goal: { kind: "race", autoFor: key } } })).toBeNull();
  });

  it("a plan written before recovery existed has no `until`, so never starts itself", () => {
    const p = racePlan();
    delete p.recovery;
    expect(due(dayAfter(raceDate, 90), { plan: p })).toBeNull();
  });

  it("not while the race is unsettled or the runner is still in the recovery", () => {
    const p = racePlan();
    p.weeks = p.weeks.map(w => ({ ...w, sessions: w.sessions.map(s => s.id === "race" ? { ...s, done: false, runId: null } : s) }));
    expect(due(dayAfter(until(), 10), { plan: p })).toBeNull();
    expect(due(until())).toBeNull();
  });

  it("settings for a plan with no race leave no race behind", () => {
    expect(openSettingsPatch({ target: "healthy", distanceKm: 10 })).toMatchObject({
      goalKind: "open", openTarget: "healthy", lightPlan: false, raceDate: "", targetEditionId: null, distanceKm: 10, goalSec: "",
    });
  });
});
