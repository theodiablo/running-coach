import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildPlan, carryProgress, findOpenPlanSession, planSessionPrefill } from "./plan";
import type { Plan } from "../types";
import { ymd } from "./format";

type TestSession = {
  id?: string;
  date: string;
  type: string;
  km: number | string;
  pace?: number | string | null;
  done?: boolean;
  desc?: string;
  editionId?: string | null;
};
type TestWeek = { weekNumber: number; startDate: string; phase: string; sessions: TestSession[] };
type TestPlan = { weeks: TestWeek[]; longRunPeakKm: number };

// buildPlan is relative to "today"; build a race date a fixed span ahead so the
// plan always has a healthy number of weeks regardless of when tests run.
function raceDateInDays(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return ymd(d);
}

const SESSIONS = [{dayOffset: 2, minutes: 30}, {dayOffset: 6, minutes: 60}];

describe("buildPlan", () => {
  it("computes flat target pace", () => {
    const plan = buildPlan(raceDateInDays(120), 7200, SESSIONS, 20, 0);
    expect(plan.targetPace).toBe(360); // 7200 / 20
  });

  it("grade-adjusts target pace for race elevation", () => {
    const plan = buildPlan(raceDateInDays(120), 7200, SESSIONS, 20, 200);
    // flatEqDist = 20 + 8*200/1000 = 21.6; round(7200 / 21.6) = 333
    expect(plan.targetPace).toBe(333);
    expect(plan.raceElevation).toBe(200);
  });

  it("ends with a single RACE-day week", () => {
    const plan = buildPlan(raceDateInDays(120), 7200, SESSIONS, 20, 0);
    const last = plan.weeks[plan.weeks.length - 1];
    expect(last.phase).toBe("RACE");
    expect(last.sessions).toHaveLength(1);
    expect(last.sessions[0].type).toBe("RACE");
    expect(last.sessions[0].km).toBe(20);
  });

  it("produces weeks with sane, well-formed sessions", () => {
    const plan = buildPlan(raceDateInDays(120), 7200, SESSIONS, 20, 0);
    expect(plan.weeks.length).toBeGreaterThan(2);
    const phases = new Set(plan.weeks.map(w => w.phase));
    expect(phases.has("RACE")).toBe(true);
    // Every non-race session is uncompleted, identified, and at least 1.5 km.
    plan.weeks.slice(0, -1).forEach(w => {
      w.sessions.forEach(s => {
        expect(s.done).toBe(false);
        expect(s.id).toBeTruthy();
        expect(s.km).toBeGreaterThanOrEqual(1.5);
        expect(s.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });
    });
  });

  it("clamps very short horizons to a minimum of 4 build weeks + race week", () => {
    const plan = buildPlan(raceDateInDays(7), 7200, SESSIONS, 20, 0);
    expect(plan.weeks.length).toBeGreaterThanOrEqual(5);
  });

  // ── Phase 1: distance-scaled long run ──────────────────────────────────────
  // Peak long run is driven by race distance, NOT the session minutes budget.
  const longKms = (plan: TestPlan) => plan.weeks.slice(0, -1)
    .flatMap(w => w.sessions).filter(s => s.type === "LONG").map(s => Number(s.km));
  const firstLong = (plan: TestPlan) => {
    for (const w of plan.weeks.slice(0, -1)) {
      const l = w.sessions.find(s => s.type === "LONG");
      if (l) return Number(l.km);
    }
    return null;
  };

  it("scales the peak long run toward race distance, not the 60-min session cap", () => {
    const plan = buildPlan(raceDateInDays(140), 6340, SESSIONS, 20, 200);
    // 0.9 * 20 = 18 km — far beyond the old ~9.8 km time-cap from a 60-min long day.
    expect(plan.longRunPeakKm).toBe(18);
    expect(Math.max(...longKms(plan))).toBeGreaterThanOrEqual(16);
  });

  it("targets a marathon long run around 30-32 km", () => {
    const plan = buildPlan(raceDateInDays(180), 14400, SESSIONS, 42.2, 0);
    expect(plan.longRunPeakKm).toBe(32);
    expect(Math.max(...longKms(plan))).toBeGreaterThanOrEqual(28);
  });

  it("clamps ultra long runs to a sane ceiling (no 150 km long run)", () => {
    const plan = buildPlan(raceDateInDays(200), 108000, SESSIONS, 171, 10000);
    expect(plan.longRunPeakKm).toBeLessThanOrEqual(36);
    expect(Math.max(...longKms(plan))).toBeLessThanOrEqual(36);
  });

  // ── Phase 1: fitness-aware start ───────────────────────────────────────────
  it("does not regress a fit athlete's first long run to 4.5 km", () => {
    const recentRuns = [{date: raceDateInDays(-7), km: 12, type: "LONG"}];
    const plan = buildPlan(raceDateInDays(140), 6340, SESSIONS, 20, 200, {recentRuns});
    // 0.8 * 12 = 9.6 km floor — well above the old 4.5 km BASE start.
    expect(firstLong(plan)).toBeGreaterThanOrEqual(9);
  });

  it("never inflates the start above the race-scaled peak (big runs, short race)", () => {
    const recentRuns = [{date: raceDateInDays(-5), km: 18, type: "LONG"}];
    const plan = buildPlan(raceDateInDays(120), 2700, SESSIONS, 10, 0, {recentRuns});
    expect(firstLong(plan)).toBeLessThanOrEqual(plan.longRunPeakKm);
  });

  it("ignores runs older than the recent window for the fitness floor", () => {
    const recentRuns = [{date: raceDateInDays(-90), km: 18, type: "LONG"}];
    const plan = buildPlan(raceDateInDays(140), 6340, SESSIONS, 20, 200, {recentRuns});
    expect(firstLong(plan)).toBeLessThanOrEqual(6);
  });

  // ── Phase 2: secondary-race overlay ────────────────────────────────────────
  const raceSessions = (plan: TestPlan) => plan.weeks.flatMap(w => w.sessions).filter(s => s.type === "RACE");

  it("inserts a secondary race as a RACE session without adding weeks", () => {
    const base = buildPlan(raceDateInDays(140), 6340, SESSIONS, 20, 200);
    const races = [{editionId: "tuneup-10k", date: raceDateInDays(60), distanceKm: 10, elevation: 90}];
    const plan = buildPlan(raceDateInDays(140), 6340, SESSIONS, 20, 200, {races});
    expect(plan.weeks.length).toBe(base.weeks.length); // no extra weeks / renumber
    const sec = raceSessions(plan).find(s => s.editionId === "tuneup-10k");
    expect(sec).toBeTruthy();
    expect(sec!.date).toBe(raceDateInDays(60));
    expect(sec!.km).toBe(10);
    expect(sec!.id).toBe("race-tuneup-10k");
    expect(Number(sec!.pace)).toBeLessThan(Number(plan.weeks.at(-1)!.sessions[0]!.pace)); // 10k faster than 20k pace
  });

  it("stamps the main race session with mainEditionId", () => {
    const plan = buildPlan(raceDateInDays(140), 6340, SESSIONS, 20, 200, {mainEditionId: "main-ed"});
    const main = plan.weeks.at(-1)!.sessions[0]!;
    expect(main.id).toBe("race");
    expect(main.editionId).toBe("main-ed");
  });

  it("leaves the main race editionId null for a hand-entered target", () => {
    const plan = buildPlan(raceDateInDays(140), 6340, SESSIONS, 20, 200);
    expect(plan.weeks.at(-1)!.sessions[0]!.editionId).toBe(null);
  });

  it("does not insert a race too close to the main race (taper guard)", () => {
    const races = [{editionId: "too-late", date: raceDateInDays(137), distanceKm: 10}];
    const plan = buildPlan(raceDateInDays(140), 6340, SESSIONS, 20, 200, {races});
    expect(raceSessions(plan).some(s => s.editionId === "too-late")).toBe(false);
  });

  it("does not insert a race outside the plan window", () => {
    const races = [
      {editionId: "after", date: raceDateInDays(160), distanceKm: 10},
      {editionId: "before", date: raceDateInDays(-10), distanceKm: 10},
    ];
    const plan = buildPlan(raceDateInDays(140), 6340, SESSIONS, 20, 200, {races});
    expect(raceSessions(plan).some(s => s.editionId === "after" || s.editionId === "before")).toBe(false);
  });

  it("dedupes to one race per date", () => {
    const races = [
      {editionId: "a", date: raceDateInDays(60), distanceKm: 10},
      {editionId: "b", date: raceDateInDays(60), distanceKm: 12},
    ];
    const plan = buildPlan(raceDateInDays(140), 6340, SESSIONS, 20, 200, {races});
    const onDate = raceSessions(plan).filter(s => s.date === raceDateInDays(60));
    expect(onDate).toHaveLength(1);
  });

  it("replaces a same-day training session rather than duplicating it", () => {
    // Drop the race on the exact date of an existing mid-plan session so the
    // collision (replace) branch always fires — not left to calendar luck.
    const base = buildPlan(raceDateInDays(140), 6340, SESSIONS, 20, 200);
    const victimWeek = base.weeks[5];
    const victim = victimWeek!.sessions[0]!;
    const races = [{editionId: "collide", date: victim.date, distanceKm: 10}];
    const plan = buildPlan(raceDateInDays(140), 6340, SESSIONS, 20, 200, {races});
    const wk = plan.weeks.find(w => w.weekNumber === victimWeek!.weekNumber)!;
    const onDate = wk.sessions.filter(s => s.date === victim.date);
    expect(onDate).toHaveLength(1);                              // replaced, not duplicated
    expect(onDate[0].type).toBe("RACE");                         // the race took the slot
    expect(wk.sessions.length).toBe(victimWeek!.sessions.length); // same count → replaced
  });

  it("eases the week around a substantial secondary race (mini-taper)", () => {
    const races = [{editionId: "half-tuneup", date: raceDateInDays(60), distanceKm: 10}]; // 10 of 20 km
    const plan = buildPlan(raceDateInDays(140), 6340, SESSIONS, 20, 200, {races});
    const wk = plan.weeks.find(w => w.sessions.some(s => s.editionId === "half-tuneup"));
    const nonRace = wk!.sessions.filter(s => s.type !== "RACE");
    expect(nonRace.every(s => s.type === "EASY")).toBe(true);
  });

  it("just drops in a small secondary race without easing the week", () => {
    const races = [{editionId: "parkrun", date: raceDateInDays(60), distanceKm: 5}]; // 5 of 42 km
    const plan = buildPlan(raceDateInDays(160), 14400, SESSIONS, 42.2, 0, {races});
    const wk = plan.weeks.find(w => w.sessions.some(s => s.editionId === "parkrun"));
    const nonRace = wk!.sessions.filter(s => s.type !== "RACE");
    // No mini-taper: the week's other session keeps its normal prescription.
    expect(nonRace.some(s => s.desc !== "Easy run — keep it light around your race")).toBe(true);
  });
});

// Frozen-clock snapshots of the default ("balanced") output, committed BEFORE
// the multi-style refactor: any later restructuring of buildPlan must reproduce
// these byte-for-byte, so a snapshot diff here means the default plan changed
// for existing users. Sanctioned (deliberate) changes so far: the additive
// `style` field, budget-derived interval reps (desc and km now always
// agree — short days get fewer reps instead of a silently clipped total), and
// the additive `sd` (structured session descriptor) used to render localized
// session sentences — `desc` (English) is unchanged and stays the canonical
// fallback, so these diffs are purely added `sd` blocks.
describe("buildPlan balanced output freeze", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T10:00:00")); // a Wednesday
  });
  afterEach(() => vi.useRealTimers());

  it("half marathon, 3 days, fit, secondary race — stable output", () => {
    const plan = buildPlan(
      "2026-10-18", 6340,
      [{dayOffset: 1, minutes: 40}, {dayOffset: 3, minutes: 45}, {dayOffset: 6, minutes: 90}],
      21.1, 150,
      {
        recentRuns: [{date: "2026-06-20", km: 14}],
        races: [{editionId: "tuneup-10k", date: "2026-08-30", distanceKm: 10, elevation: 50}],
        mainEditionId: "main-half",
      },
    );
    expect(plan).toMatchSnapshot();
  });

  it("marathon, default 2 days, from scratch — stable output", () => {
    const plan = buildPlan("2026-12-06", 14400, undefined, 42.2, 0);
    expect(plan).toMatchSnapshot();
  });
});

// A day can hold both a run and a cross-training session. Auto-tick must never
// cross the two: a bike session ticking off the easy run (or vice versa) marks
// work as done that wasn't. See docs/indoor-sessions.md.
describe("findOpenPlanSession", () => {
  const plan = {
    weeks: [{
      weekNumber: 3,
      sessions: [
        { id: "s-easy",  date: "2026-08-12", type: "EASY" },
        { id: "s-cross", date: "2026-08-12", type: "OTHER" },
        { id: "s-done",  date: "2026-08-13", type: "EASY", done: true },
        { id: "s-race",  date: "2026-08-14", type: "RACE" },
      ],
    }],
  };

  it("matches either kind when unfiltered", () => {
    expect(findOpenPlanSession(plan, "2026-08-12")).toEqual({ wNum: 3, sId: "s-easy" });
  });

  it("keeps a run off the cross-training session and vice versa", () => {
    expect(findOpenPlanSession(plan, "2026-08-12", { crossTraining: false })).toEqual({ wNum: 3, sId: "s-easy" });
    expect(findOpenPlanSession(plan, "2026-08-12", { crossTraining: true })).toEqual({ wNum: 3, sId: "s-cross" });
  });

  it("returns null rather than the wrong session when the day has only the other kind", () => {
    const runOnlyDay = { weeks: [{ weekNumber: 1, sessions: [{ id: "s1", date: "2026-08-12", type: "EASY" }] }] };
    expect(findOpenPlanSession(runOnlyDay, "2026-08-12", { crossTraining: true })).toBeNull();
  });

  it("still skips done, skipped and RACE sessions", () => {
    expect(findOpenPlanSession(plan, "2026-08-13")).toBeNull();
    expect(findOpenPlanSession(plan, "2026-08-14")).toBeNull();
    expect(findOpenPlanSession(plan, "2026-08-20")).toBeNull();
    expect(findOpenPlanSession(null, "2026-08-12")).toBeNull();
  });
});

describe("planSessionPrefill", () => {
  it("carries distance and pace for a run", () => {
    expect(planSessionPrefill({ id: "s1", date: "2026-08-12", type: "EASY", km: 8, pace: 330 }, 3))
      .toEqual({ date: "2026-08-12", type: "EASY", km: 8, pace: 330, wNum: 3, sId: "s1" });
  });

  // buildPlan gives cross-training a synthetic km purely to satisfy the coach
  // validator's km > 0 rule. Prefilling it would save a distance nobody covered
  // as real running km — the exact contamination km:0 exists to prevent.
  it("drops the synthetic distance for cross-training and prefills the duration", () => {
    const prefill = planSessionPrefill(
      { id: "s2", date: "2026-08-12", type: "OTHER", km: 6, pace: 400, sd: { kind: "cross", minutes: 40 } }, 3);
    expect(prefill).toEqual({ date: "2026-08-12", type: "OTHER", durationSec: 2400, wNum: 3, sId: "s2" });
    expect(prefill).not.toHaveProperty("km");
    expect(prefill).not.toHaveProperty("pace");
  });

  it("omits the duration when the session doesn't prescribe one", () => {
    expect(planSessionPrefill({ id: "s3", date: "2026-08-12", type: "OTHER", km: 6 }, 3))
      .toEqual({ date: "2026-08-12", type: "OTHER", wNum: 3, sId: "s3" });
  });
});

// ── carryProgress ───────────────────────────────────────────────────────────
// Session ids (w{n}d{dOff}) name a slot in the plan grid, not a day. Matching
// on them across a rebuild transplanted four weeks of done/skipped a month
// into the future when a race date moved — cancelling sessions the runner had
// never seen. Rebuilds anchor on the calendar date instead; only the coach,
// whose proposal is derived from the live plan, still matches by id.
describe("carryProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T10:00:00"));
  });
  afterEach(() => vi.useRealTimers());

  type Sess = { id: string; date: string; type?: string; done?: boolean; skipped?: boolean; runId?: string | null };
  const mk = (sessions: Sess[]): Plan => ({
    weeks: [{
      weekNumber: 1, startDate: sessions[0]?.date, phase: "BASE",
      sessions: sessions.map(s => ({ type: "EASY", desc: "", km: 5, pace: 330, done: false, runId: null, ...s })),
    }],
  });
  const flags = (p: Plan) => p.weeks.flatMap(w => w.sessions)
    .map(s => ({ id: s.id, date: s.date, done: !!s.done, skipped: !!s.skipped }));

  it("keeps progress when a rebuild leaves the dates alone", () => {
    const old = mk([
      { id: "w1d2", date: "2026-08-04", done: true, runId: "r1" },
      { id: "w1d4", date: "2026-08-06", skipped: true },
    ]);
    const built = mk([{ id: "w1d2", date: "2026-08-04" }, { id: "w1d4", date: "2026-08-06" }]);
    expect(flags(carryProgress(old, built))).toEqual([
      { id: "w1d2", date: "2026-08-04", done: true, skipped: false },
      { id: "w1d4", date: "2026-08-06", done: false, skipped: true },
    ]);
    expect(carryProgress(old, built).weeks[0].sessions[0].runId).toBe("r1");
  });

  // The reported bug: same slot ids, dates shifted four weeks by a new race
  // date. Nothing may carry — those future days were never trained.
  it("does not smear progress onto new dates when the plan start shifts", () => {
    const old = mk([
      { id: "w2d2", date: "2026-07-29", done: true },
      { id: "w2d4", date: "2026-07-31", skipped: true },
      { id: "w2d6", date: "2026-08-01", skipped: true },
    ]);
    const built = mk([
      { id: "w2d2", date: "2026-08-26" },
      { id: "w2d4", date: "2026-08-28" },
      { id: "w2d6", date: "2026-08-30" },
    ]);
    expect(flags(carryProgress(old, built))).toEqual([
      { id: "w2d2", date: "2026-08-26", done: false, skipped: false },
      { id: "w2d4", date: "2026-08-28", done: false, skipped: false },
      { id: "w2d6", date: "2026-08-30", done: false, skipped: false },
    ]);
  });

  // Self-heal: a plan already corrupted by the old slot-id carry holds `done`
  // on future dates. Re-stamping it must not launder that forward.
  it("drops a done flag landing on a future date", () => {
    const old = mk([{ id: "w2d2", date: "2026-09-02", done: true }]);
    const built = mk([{ id: "w2d2", date: "2026-09-02" }]);
    expect(flags(carryProgress(old, built))).toEqual([
      { id: "w2d2", date: "2026-09-02", done: false, skipped: false },
    ]);
  });

  it("hands a same-day flag to the matching kind, not the other one", () => {
    const old = mk([
      { id: "w1d2", date: "2026-08-04", type: "OTHER", skipped: true },
      { id: "w1d3", date: "2026-08-04", type: "EASY", done: true },
    ]);
    const built = mk([
      { id: "w1d2", date: "2026-08-04", type: "EASY" },
      { id: "w1d3", date: "2026-08-04", type: "OTHER" },
    ]);
    expect(flags(carryProgress(old, built))).toEqual([
      { id: "w1d2", date: "2026-08-04", done: true, skipped: false },
      { id: "w1d3", date: "2026-08-04", done: false, skipped: true },
    ]);
  });

  // Race ids are real identity, so they follow the race even if its date moved.
  it("matches races by id across a date change", () => {
    const old = mk([{ id: "race-abc", date: "2026-10-11", type: "RACE", done: true }]);
    const built = mk([{ id: "race-abc", date: "2026-10-18", type: "RACE" }]);
    const out = carryProgress(old, built).weeks[0].sessions[0];
    expect(out.date).toBe("2026-10-18");
    expect(out.done).toBe(false); // future race, not yet run
  });

  it("carries a skipped race by id", () => {
    const old = mk([{ id: "race-abc", date: "2026-10-11", type: "RACE", skipped: true }]);
    const built = mk([{ id: "race-abc", date: "2026-10-18", type: "RACE" }]);
    expect(carryProgress(old, built).weeks[0].sessions[0].skipped).toBe(true);
  });

  describe("coach mode", () => {
    it("keeps flags on a session the coach shifted to another date", () => {
      const old = mk([{ id: "w1d2", date: "2026-08-04", skipped: true }]);
      const proposal = mk([{ id: "w1d2", date: "2026-08-05" }]);
      expect(carryProgress(old, proposal, "coach").weeks[0].sessions[0].skipped).toBe(true);
    });

    // cancel_session marks skipped on the PROPOSAL; the re-stamp must not
    // overwrite it with the live plan's un-skipped state.
    it("unions skipped so cancel_session survives the re-stamp", () => {
      const old = mk([{ id: "w1d2", date: "2026-08-04", skipped: false }]);
      const proposal = mk([{ id: "w1d2", date: "2026-08-04", skipped: true }]);
      expect(carryProgress(old, proposal, "coach").weeks[0].sessions[0].skipped).toBe(true);
    });

    it("keeps a session the user skipped while the chat was open", () => {
      const old = mk([{ id: "w1d2", date: "2026-08-04", skipped: true }]);
      const proposal = mk([{ id: "w1d2", date: "2026-08-04", skipped: false }]);
      expect(carryProgress(old, proposal, "coach").weeks[0].sessions[0].skipped).toBe(true);
    });
  });

  it("returns the new plan untouched when there is no old plan", () => {
    const built = mk([{ id: "w1d2", date: "2026-08-04" }]);
    expect(carryProgress(null, built)).toBe(built);
  });
});
