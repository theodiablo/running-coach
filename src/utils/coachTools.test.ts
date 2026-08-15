import { describe, it, expect } from "vitest";
// @ts-expect-error Shared edge-function ESM has no TypeScript declarations yet.
import { TOOL_DEFS, applyToolCall, assessGoalFeasibility, CoachToolError } from "../../supabase/functions/_shared/coach/tools.mjs";
import { validatePlan } from "./coachValidation";

type TestSession = {
  id: string;
  date: string;
  type: string;
  km: number;
  pace: number | null;
  done: boolean;
  desc?: string;
  skipped?: boolean;
};
type TestWeek = { weekNumber: number; startDate: string; phase: string; sessions: TestSession[] };
type TestPlan = { raceDate: string; distanceKm: number; goalSec: number; targetPace: number; planSessions: unknown[]; style?: string; weeks: TestWeek[] };
type ToolInput = Record<string, string | number>;
type ToolName =
  | "shift_workout"
  | "swap_session"
  | "reduce_week_volume"
  | "insert_recovery_week"
  | "convert_to_cross_training"
  | "reduce_session_distance"
  | "cancel_session"
  | "add_session";
type ToolDef = { name: string };

const toolDefs = TOOL_DEFS as ToolDef[];
// The fixture below lives on a fixed calendar and the tools refuse dates that
// have already passed, so every call carries a pinned `today` sitting at the
// start of the plan. Past-date tests pass their own.
const TODAY = "2026-01-05";
const applyToolRaw = applyToolCall as (plan: TestPlan, name: string, input: ToolInput, opts?: { today?: string }) => TestPlan;
const applyTool = (plan: TestPlan, name: string, input: ToolInput, today: string = TODAY) =>
  applyToolRaw(plan, name, input, { today });
const assessGoal = assessGoalFeasibility as (input: {
  goal: { goalSec: number; distanceKm: number; raceDate: string };
  targetPace: number;
  recentRuns: { date: string; type: string; km: number; durationSec: number }[];
}) => string;

const sess = (id: string, date: string, type: string, km: number, extra: Partial<TestSession> = {}): TestSession =>
  ({ id, date, type, km, pace: 360, done: false, ...extra });
const plan = (): TestPlan => ({
  raceDate: "2026-02-14", distanceKm: 20, goalSec: 6600, targetPace: 330, planSessions: [],
  weeks: [
    { weekNumber: 1, startDate: "2026-01-05", phase: "BUILD", sessions: [
      sess("w1d2", "2026-01-07", "TEMPO", 5), sess("w1d6", "2026-01-11", "LONG", 10),
    ]},
    { weekNumber: 2, startDate: "2026-01-12", phase: "BUILD", sessions: [
      sess("w2d2", "2026-01-14", "EASY", 4, { done: true }), sess("w2d6", "2026-01-18", "LONG", 11),
    ]},
    { weekNumber: 3, startDate: "2026-01-19", phase: "RACE", sessions: [
      sess("race", "2026-01-24", "RACE", 20),
    ]},
  ],
});

describe("applyToolCall", () => {
  it("never mutates the input plan", () => {
    const p = plan();
    const snapshot = JSON.stringify(p);
    applyTool(p, "reduce_week_volume", { week_number: 1, factor: 0.7 });
    applyTool(p, "shift_workout", { session_id: "w1d2", new_date: "2026-01-08" });
    expect(JSON.stringify(p)).toBe(snapshot);
  });

  it("shift_workout moves a session across weeks and keeps weeks sorted", () => {
    const out = applyTool(plan(), "shift_workout", { session_id: "w1d2", new_date: "2026-01-13" });
    expect(out.weeks[0].sessions.map(s => s.id)).toEqual(["w1d6"]);
    const moved = out.weeks[1].sessions.find(s => s.id === "w1d2");
    expect(moved!.date).toBe("2026-01-13");
    expect(out.weeks[1].sessions.map(s => s.date)).toEqual([...out.weeks[1].sessions.map(s => s.date)].sort());
  });

  it("shift_workout refuses races, done sessions, race day and out-of-plan dates", () => {
    expect(() => applyTool(plan(), "shift_workout", { session_id: "race", new_date: "2026-01-20" })).toThrow(CoachToolError);
    expect(() => applyTool(plan(), "shift_workout", { session_id: "w2d2", new_date: "2026-01-15" })).toThrow(/completed/);
    expect(() => applyTool(plan(), "shift_workout", { session_id: "w1d2", new_date: "2026-02-20" })).toThrow(/race day/);
    expect(() => applyTool(plan(), "shift_workout", { session_id: "w1d2", new_date: "2026-02-01" })).toThrow(/outside/);
    expect(() => applyTool(plan(), "shift_workout", { session_id: "nope", new_date: "2026-01-13" })).toThrow(/No session/);
  });

  it("swap_session recomputes type, pace and description", () => {
    const out = applyTool(plan(), "swap_session", { session_id: "w1d2", new_type: "EASY" });
    const s = out.weeks[0].sessions.find(x => x.id === "w1d2");
    expect(s!.type).toBe("EASY");
    expect(s!.pace).toBe(Math.round(330 * 1.25));
    expect(s!.desc).toMatch(/Easy run/);
    expect(() => applyTool(plan(), "swap_session", { session_id: "w1d2", new_type: "RACE" })).toThrow(/new_type/);
  });

  it("swap_session derives paces from the plan's methodology style", () => {
    const styled = () => ({ ...plan(), style: "polarized" });
    const out = applyTool(styled(), "swap_session", { session_id: "w1d2", new_type: "EASY" });
    expect(out.weeks[0].sessions.find(x => x.id === "w1d2")!.pace).toBe(Math.round(330 * 1.32));
    // Unknown style degrades to the balanced ratios (forward compatibility).
    const weird = applyTool({ ...plan(), style: "vaporware" }, "swap_session", { session_id: "w1d2", new_type: "EASY" });
    expect(weird.weeks[0].sessions.find(x => x.id === "w1d2")!.pace).toBe(Math.round(330 * 1.25));
  });

  it("swap_session keeps run/walk vocabulary on runwalk plans", () => {
    const out = applyTool({ ...plan(), style: "runwalk" }, "swap_session", { session_id: "w1d2", new_type: "EASY" });
    expect(out.weeks[0].sessions.find(x => x.id === "w1d2")!.desc).toMatch(/Run\/walk/);
  });

  it("WALK pace comes from the shared table: paced run/walk on runwalk swaps, unpaced elsewhere", () => {
    // Swap → a real run/walk session at the generator's walk pace.
    const rw = applyTool({ ...plan(), style: "runwalk" }, "swap_session", { session_id: "w1d2", new_type: "WALK" });
    const rwSess = rw.weeks[0].sessions.find(x => x.id === "w1d2")!;
    expect(rwSess.pace).toBe(Math.round(330 * 1.45));
    expect(rwSess.desc).toMatch(/Run\/walk/);
    // Style-less plans keep the pre-styles unpaced cross-training WALK.
    const plain = applyTool(plan(), "swap_session", { session_id: "w1d2", new_type: "WALK" });
    expect(plain.weeks[0].sessions.find(x => x.id === "w1d2")!.pace).toBe(null);
    // A pain-relief conversion stays no-impact and unpaced even on runwalk.
    const conv = applyTool({ ...plan(), style: "runwalk" }, "convert_to_cross_training", { session_id: "w1d2" });
    const convSess = conv.weeks[0].sessions.find(x => x.id === "w1d2")!;
    expect(convSess.pace).toBe(null);
    expect(convSess.desc).toMatch(/no impact/);
  });

  it("reduce_week_volume scales only remaining training sessions", () => {
    const out = applyTool(plan(), "reduce_week_volume", { week_number: 2, factor: 0.5 });
    expect(out.weeks[1]!.sessions.find(s => s.id === "w2d2")!.km).toBe(4); // done — untouched
    expect(out.weeks[1]!.sessions.find(s => s.id === "w2d6")!.km).toBe(5.5);
    expect(() => applyTool(plan(), "reduce_week_volume", { week_number: 2, factor: 1.2 })).toThrow(/factor/);
    expect(() => applyTool(plan(), "reduce_week_volume", { week_number: 9, factor: 0.5 })).toThrow(/No week/);
  });

  it("insert_recovery_week converts remaining sessions to short EASY runs", () => {
    const out = applyTool(plan(), "insert_recovery_week", { week_number: 1 });
    for (const s of out.weeks[0].sessions) {
      expect(s.type).toBe("EASY");
      expect(s.km).toBeLessThanOrEqual(6);
    }
  });

  it("convert_to_cross_training makes a WALK with no pace", () => {
    const out = applyTool(plan(), "convert_to_cross_training", { session_id: "w1d6" });
    const s = out.weeks[0].sessions.find(x => x.id === "w1d6");
    expect(s!.type).toBe("WALK");
    expect(s!.pace).toBeNull();
  });

  it("reduce_session_distance shortens only the target session, with a floor", () => {
    const out = applyTool(plan(), "reduce_session_distance", { session_id: "w1d6", factor: 0.5 });
    expect(out.weeks[0]!.sessions.find(s => s.id === "w1d6")!.km).toBe(5);
    expect(out.weeks[0]!.sessions.find(s => s.id === "w1d2")!.km).toBe(5); // untouched
    const floored = applyTool(plan(), "reduce_session_distance", { session_id: "w1d2", factor: 0.3 });
    expect(floored.weeks[0]!.sessions.find(s => s.id === "w1d2")!.km).toBe(1.5);
    expect(() => applyTool(plan(), "reduce_session_distance", { session_id: "w1d2", factor: 1.2 })).toThrow(/factor/);
    expect(() => applyTool(plan(), "reduce_session_distance", { session_id: "w2d2", factor: 0.5 })).toThrow(/completed/);
    expect(() => applyTool(plan(), "reduce_session_distance", { session_id: "race", factor: 0.5 })).toThrow(/race/);
  });

  it("cancel_session marks skipped and refuses done/RACE sessions", () => {
    const out = applyTool(plan(), "cancel_session", { session_id: "w1d2" });
    expect(out.weeks[0]!.sessions.find(s => s.id === "w1d2")!.skipped).toBe(true);
    expect(() => applyTool(plan(), "cancel_session", { session_id: "w2d2" })).toThrow(/completed/);
    expect(() => applyTool(plan(), "cancel_session", { session_id: "race" })).toThrow(/race/);
  });

  it("add_session inserts a capped, sorted session with a fresh id", () => {
    const out = applyTool(plan(), "add_session", { date: "2026-01-08", type: "EASY", km: 5 });
    const added = out.weeks[0].sessions.find(s => s.id === "coach-add-2026-01-08");
    expect(added).toMatchObject({ type: "EASY", km: 5, done: false });
    expect(added!.pace).toBe(Math.round(330 * 1.25));
    expect(out.weeks[0].sessions.map(s => s.date)).toEqual([...out.weeks[0].sessions.map(s => s.date)].sort());
    // Same-date collision gets a suffixed id, not a duplicate.
    const twice = applyTool(out, "add_session", { date: "2026-01-08", type: "WALK", km: 3 });
    expect(twice.weeks[0].sessions.filter(s => s.date === "2026-01-08").map(s => s.id))
      .toEqual(["coach-add-2026-01-08", "coach-add-2026-01-08-2"]);
  });

  it("add_session refuses taper dates, oversized runs and out-of-plan dates", () => {
    // Race day is 2026-02-14: 2026-02-05 is inside the final 14 days.
    expect(() => applyTool(plan(), "add_session", { date: "2026-02-05", type: "EASY", km: 5 })).toThrow(/final 14 days/);
    // Longest training session in the fixture is 11 km.
    expect(() => applyTool(plan(), "add_session", { date: "2026-01-08", type: "LONG", km: 15 })).toThrow(/longest/);
    expect(() => applyTool(plan(), "add_session", { date: "2026-01-30", type: "EASY", km: 5 })).toThrow(/outside/);
    expect(() => applyTool(plan(), "add_session", { date: "2026-01-08", type: "RACE", km: 5 })).toThrow(/type/);
    expect(() => applyTool(plan(), "add_session", { date: "2026-01-08", type: "EASY", km: 0 })).toThrow(/km/);
  });

  // ── the past is read-only ──────────────────────────────────────────────────
  // A rebuild keeps the elapsed weeks in the plan, so the model can now see and
  // address days that have already been lived. The plan doubles as the training
  // record: every mutating tool refuses them.
  describe("refuses to rewrite the past", () => {
    // Week 1 (2026-01-05) has ended by here; weeks 2-3 have not.
    const LATER = "2026-01-13";

    it("refuses every session-level tool on a past-dated session", () => {
      const cases: [ToolName, ToolInput][] = [
        ["shift_workout", { session_id: "w1d2", new_date: "2026-01-15" }],
        ["swap_session", { session_id: "w1d2", new_type: "EASY" }],
        ["reduce_session_distance", { session_id: "w1d2", factor: 0.5 }],
        ["cancel_session", { session_id: "w1d2" }],
        ["convert_to_cross_training", { session_id: "w1d2" }],
      ];
      for (const [name, input] of cases) {
        expect(() => applyTool(plan(), name, input, LATER)).toThrow(/already passed/);
      }
    });

    it("refuses the whole-week tools on a week that has ended", () => {
      expect(() => applyTool(plan(), "reduce_week_volume", { week_number: 1, factor: 0.7 }, LATER))
        .toThrow(/already passed/);
      expect(() => applyTool(plan(), "insert_recovery_week", { week_number: 1 }, LATER))
        .toThrow(/already passed/);
    });

    it("refuses moving a session onto, or adding one to, a day that has passed", () => {
      expect(() => applyTool(plan(), "shift_workout", { session_id: "w2d6", new_date: "2026-01-06" }, LATER))
        .toThrow(/already passed/);
      expect(() => applyTool(plan(), "add_session", { date: "2026-01-06", type: "EASY", km: 5 }, LATER))
        .toThrow(/already passed/);
    });

    it("still allows today and yesterday, so a missed session stays actionable", () => {
      // `today` is UTC while a session's date is the runner's local day, so the
      // guard carries a day of slack rather than refusing the runner's own
      // "I can't run today" in a western evening.
      expect(applyTool(plan(), "cancel_session", { session_id: "w1d6" }, "2026-01-11")
        .weeks[0].sessions.find(s => s.id === "w1d6")!.skipped).toBe(true);
      expect(applyTool(plan(), "cancel_session", { session_id: "w1d6" }, "2026-01-12")
        .weeks[0].sessions.find(s => s.id === "w1d6")!.skipped).toBe(true);
      expect(() => applyTool(plan(), "cancel_session", { session_id: "w1d6" }, "2026-01-13"))
        .toThrow(/already passed/);
    });

    it("caps an added session against the live weeks, not a past block's peak", () => {
      // The fixture's 11 km long run is in week 2; the retained week 1 holds a
      // 10 km one. Once week 2 is also past, the cap must fall to what is left.
      const p = plan();
      p.weeks[2]!.sessions = [sess("w3d2", "2026-01-21", "EASY", 4)];
      p.weeks[2]!.phase = "BUILD";
      expect(() => applyTool(p, "add_session", { date: "2026-01-22", type: "EASY", km: 8 }, "2026-01-20"))
        .toThrow(/longest/);
    });
  });

  it("rejects unknown tools", () => {
    expect(() => applyTool(plan(), "delete_everything", {})).toThrow(/Unknown tool/);
  });

  it("get_run_detail is defined (read-only) and requires run_id", () => {
    const def = toolDefs.find(d => d.name === "get_run_detail") as ToolDef & { input_schema: { required: string[] } };
    expect(def).toBeDefined();
    expect(def.input_schema.required).toEqual(["run_id"]);
    // Read-only: the plan-transform dispatcher must refuse it.
    expect(() => applyTool(plan(), "get_run_detail", { run_id: "x" })).toThrow(/Unknown tool/);
  });

  // Property: any single tool applied with valid input to a valid plan yields a
  // plan the validator can always process (structured result, never a throw).
  it("tool → validate never throws; results stay structured", () => {
    const toolInputs = {
      shift_workout: { session_id: "w1d2", new_date: "2026-01-09" },
      swap_session: { session_id: "w1d2", new_type: "WALK" },
      reduce_week_volume: { week_number: 1, factor: 0.6 },
      insert_recovery_week: { week_number: 1 },
      convert_to_cross_training: { session_id: "w1d6" },
      reduce_session_distance: { session_id: "w1d6", factor: 0.7 },
      cancel_session: { session_id: "w1d2" },
      add_session: { date: "2026-01-08", type: "EASY", km: 5 },
    };
    for (const def of toolDefs) {
      // Read-only tools are dispatched by the engine, not applyToolCall.
      if (["reassess_goal_feasibility", "remember_runner_context", "get_run_detail"].includes(def.name)) continue;
      const out = applyTool(plan(), def.name, toolInputs[def.name as ToolName]);
      const r = validatePlan(out, { baseline: plan(), today: TODAY });
      expect(Array.isArray(r.errors)).toBe(true);
      expect(Array.isArray(r.warnings)).toBe(true);
      expect(typeof r.ok).toBe("boolean");
    }
  });
});

describe("assessGoalFeasibility", () => {
  const goal = { goal: { goalSec: 6600, distanceKm: 21.1, raceDate: "2026-05-01" }, targetPace: 313 };
  const today = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

  it("asks for data when there are no runs", () => {
    expect(assessGoal({ ...goal, recentRuns: [] })).toMatch(/log a few runs/i);
  });
  it("calls out an unrealistic goal", () => {
    const runs = [{ date: today(3), type: "EASY", km: 5, durationSec: 5 * 450 }]; // 7:30/km best
    expect(assessGoal({ ...goal, recentRuns: runs })).toMatch(/UNREALISTIC/);
  });
  it("accepts a plausible goal", () => {
    const runs = [
      { date: today(10), type: "TEMPO", km: 8, durationSec: 8 * 310 },
      { date: today(5), type: "LONG", km: 15, durationSec: 15 * 380 },
    ];
    expect(assessGoal({ ...goal, recentRuns: runs })).toMatch(/plausible/);
  });
  it("flags a conservative goal when recent paces are comfortably faster", () => {
    // Target 313 s/km; best recent pace 280 (≤ 0.93×) with real endurance —
    // the "plan feels too easy" case should point at the goal, not the plan.
    const runs = [
      { date: today(4), type: "TEMPO", km: 8, durationSec: 8 * 280 },
      { date: today(9), type: "LONG", km: 15, durationSec: 15 * 340 },
    ];
    expect(assessGoal({ ...goal, recentRuns: runs })).toMatch(/CONSERVATIVE/);
  });

  // A bike ride's distance and pace are not running fitness. Only rows logged
  // before the form stopped offering cross-training a distance still carry one,
  // and reading them here talked the coach into endorsing a harder goal.
  it("ignores cross-training when judging fitness", () => {
    const runs = [
      { date: today(4), type: "OTHER", km: 30, durationSec: 3600 }, // 2:00/km on a bike
      { date: today(6), type: "EASY", km: 8, durationSec: 8 * 360 },
    ];
    const out = assessGoal({ ...goal, recentRuns: runs });
    expect(out).not.toMatch(/CONSERVATIVE/);
    expect(out).not.toMatch(/longest recent run 30\.0 km/);
    expect(out).not.toMatch(/2:00\/km/);
  });

  it("bases longest/pace stats on the last 4 weeks, not stale older history", () => {
    // A big long run and fast pace from 3 months ago must not make a currently
    // inactive runner's goal look supported by "recent" fitness.
    const runs = [
      { date: today(90), type: "LONG", km: 30, durationSec: 30 * 270 },
      { date: today(85), type: "TEMPO", km: 10, durationSec: 10 * 280 },
    ];
    const out = assessGoal({ ...goal, recentRuns: runs });
    expect(out).not.toMatch(/longest recent run 30\.0 km/);
    expect(out).toMatch(/no runs logged in that window/);
    expect(out).toMatch(/longest run on record 30\.0 km/);
  });
});
