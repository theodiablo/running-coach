// Offline eval harness for the coach agent. These cases drive the same
// generateProposal loop the edge function uses, but with scripted model turns so
// it never calls Anthropic. Assertions check coaching/safety properties rather
// than exact wording.

import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error Shared edge-function ESM has no TypeScript declarations yet.
import { generateProposal, buildMessages } from "../../supabase/functions/_shared/coach/engine.mjs";
// @ts-expect-error Shared edge-function ESM has no TypeScript declarations yet.
import { createMockModel } from "../../supabase/functions/_shared/coach/mock.mjs";
import { validatePlan } from "./coachValidation";
import { buildPlan } from "./plan";
import { ymd } from "./format";

type TestSession = {
  id: string;
  date: string;
  type: string;
  km: number;
  done?: boolean;
  skipped?: boolean;
  weekNumber?: number;
};
type TestWeek = { weekNumber: number; phase: string; sessions: TestSession[] };
type TestPlan = { raceDate: string; targetPace: number; weeks: TestWeek[] };
type TestContext = ReturnType<typeof makeContext>;
type ToolCall = { name: string; input: Record<string, string | number> };
type ProposalResult = { status: string; changed?: boolean; plan?: TestPlan };

const SESSIONS = [{ dayOffset: 2, minutes: 45 }, { dayOffset: 6, minutes: 90 }];
const weeksOut = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n * 7);
  return ymd(d);
};

function makeContext(report: string) {
  const plan = buildPlan(weeksOut(18), 6600, SESSIONS, 21.1, 0, {}) as TestPlan;
  return {
    plan,
    report,
    today: ymd(new Date()),
    // Mirrors the production projection in coach-agent/index.ts (id + hasDetail
    // are what get_run_detail keys off).
    recentRuns: [{ id: "seed-1", date: ymd(new Date(Date.now() - 3 * 86400000)), type: "EASY", km: 6, durationSec: 6 * 380, hasDetail: false }],
    goal: { raceDate: plan.raceDate, distanceKm: 21.1, goalSec: 6600 },
    goalSec: 6600,
    distanceKm: 21.1,
    raceDate: plan.raceDate,
    targetPace: plan.targetPace,
  };
}

function scriptedModel(turns: ToolCall[][], finalText = "This keeps the plan safer without chasing missed volume.") {
  let turn = 0;
  return async () => {
    const calls = turns[Math.min(turn, turns.length - 1)] || [];
    turn++;
    if (!calls.length) {
      return { content: [{ type: "text", text: finalText }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } };
    }
    return {
      content: [
        { type: "text", text: "Adjusting the plan." },
        ...calls.map((c, i) => ({ type: "tool_use", id: `toolu_${turn}_${i}`, name: c.name, input: c.input })),
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  };
}

const run = (context: TestContext, turns: ToolCall[][], finalText?: string) => generateProposal({
  baseline: context.plan,
  context,
  callModel: scriptedModel(turns, finalText),
}) as Promise<ProposalResult>;

const buildWeek = (plan: TestPlan) => plan.weeks.find(w => w.phase === "BUILD" && w.sessions.some(s => s.type !== "RACE"))!;
const weekVol = (week: TestWeek) => week.sessions.reduce((sum, s) => sum + (s.type === "RACE" ? 0 : s.km), 0);
const allSessions = (plan: TestPlan) => plan.weeks.flatMap(w => w.sessions.map(s => ({ ...s, weekNumber: w.weekNumber })));
const hardness: Record<string, number> = { WALK: 0, OTHER: 0, EASY: 1, LONG: 2, TEMPO: 3, INTERVALS: 4, RACE: 5 };

const cases = [
  {
    name: "knee pain removes impact and does not increase intensity",
    async check() {
      const context = makeContext("my knee hurts after yesterday's run");
      const hard = allSessions(context.plan).find(s => ["TEMPO", "INTERVALS", "LONG"].includes(s.type))!;
      const before = context.plan.weeks.find(w => w.weekNumber === hard.weekNumber)!;
      const result = await run(context, [
        [
          { name: "convert_to_cross_training", input: { session_id: hard.id } },
          { name: "reduce_week_volume", input: { week_number: hard.weekNumber, factor: 0.7 } },
        ],
        [],
      ]);
      expect(result.status).toBe("proposed");
      const after = result.plan!.weeks.find(w => w.weekNumber === hard.weekNumber)!;
      expect(after.sessions.find(s => s.id === hard.id)!.type).toBe("WALK");
      expect(weekVol(after)).toBeLessThanOrEqual(weekVol(before));
      for (const s of after.sessions) {
        const original = before.sessions.find(x => x.id === s.id);
        if (original) expect(hardness[s.type]).toBeLessThanOrEqual(hardness[original.type]);
      }
      expect(validatePlan(result.plan, { baseline: context.plan }).ok).toBe(true);
    },
  },
  {
    name: "missed week resumes gently without make-up volume",
    async check() {
      const context = makeContext("I missed the whole week");
      const week = buildWeek(context.plan);
      const result = await run(context, [
        [{ name: "insert_recovery_week", input: { week_number: week.weekNumber } }],
        [],
      ]);
      expect(result.status).toBe("proposed");
      const after = result.plan!.weeks.find(w => w.weekNumber === week.weekNumber)!;
      expect(weekVol(after)).toBeLessThanOrEqual(weekVol(week));
      expect(after.sessions.every(s => s.type === "EASY" || s.type === "RACE")).toBe(true);
      expect(validatePlan(result.plan, { baseline: context.plan }).ok).toBe(true);
    },
  },
  {
    name: "overreaching dials down a week",
    async check() {
      const context = makeContext("I am overreaching and exhausted");
      const week = buildWeek(context.plan);
      const result = await run(context, [
        [{ name: "reduce_week_volume", input: { week_number: week.weekNumber, factor: 0.6 } }],
        [],
      ]);
      expect(result.status).toBe("proposed");
      const after = result.plan!.weeks.find(w => w.weekNumber === week.weekNumber)!;
      expect(weekVol(after)).toBeLessThan(weekVol(week));
      expect(validatePlan(result.plan, { baseline: context.plan }).ok).toBe(true);
    },
  },
  {
    name: "schedule clash moves one editable session to a requested date",
    async check() {
      const context = makeContext("I cannot run this Wednesday");
      const session = allSessions(context.plan).find(s => s.type !== "RACE" && !s.done)!;
      const d = new Date(session.date + "T00:00:00");
      d.setDate(d.getDate() + 1);
      const newDate = ymd(d);
      const result = await run(context, [
        [{ name: "shift_workout", input: { session_id: session.id, new_date: newDate } }],
        [],
      ]);
      expect(result.status).toBe("proposed");
      expect(allSessions(result.plan!).find(s => s.id === session.id)!.date).toBe(newDate);
      expect(validatePlan(result.plan, { baseline: context.plan }).ok).toBe(true);
    },
  },
  {
    name: "goal feasibility assessment can answer without mutating the plan",
    async check() {
      const context = makeContext("is my goal still realistic?");
      const result = await run(context, [
        [{ name: "reassess_goal_feasibility", input: {} }],
        [],
      ], "Your goal looks plausible if the remaining plan stays consistent.");
      expect(result.status).toBe("proposed");
      expect(result.changed).toBe(false);
      expect(result.plan).toEqual(context.plan);
    },
  },
  {
    name: "single long run shortened without touching the rest of the week",
    async check() {
      const context = makeContext("this Sunday's long run is too much, just shorten it");
      const long = allSessions(context.plan).find(s => s.type === "LONG" && !s.done)!;
      const week = context.plan.weeks.find(w => w.weekNumber === long.weekNumber)!;
      const result = await run(context, [
        [{ name: "reduce_session_distance", input: { session_id: long.id, factor: 0.7 } }],
        [],
      ]);
      expect(result.status).toBe("proposed");
      const after = result.plan!.weeks.find(w => w.weekNumber === long.weekNumber)!;
      expect(after.sessions.find(s => s.id === long.id)!.km).toBeLessThan(long.km);
      for (const s of after.sessions) {
        if (s.id === long.id) continue;
        expect(s.km).toBe(week.sessions.find(x => x.id === s.id)!.km);
      }
      expect(validatePlan(result.plan, { baseline: context.plan }).ok).toBe(true);
    },
  },
  {
    name: "cancelled session is marked skipped, everything else untouched",
    async check() {
      const context = makeContext("drop Wednesday's run this week, I need the rest");
      const target = allSessions(context.plan).find(s => s.type !== "RACE" && !s.done)!;
      const result = await run(context, [
        [{ name: "cancel_session", input: { session_id: target.id } }],
        [],
      ]);
      expect(result.status).toBe("proposed");
      const after = allSessions(result.plan!);
      expect(after.find(s => s.id === target.id)!.skipped).toBe(true);
      expect(after.filter(s => s.id !== target.id && s.skipped)).toHaveLength(0);
      expect(validatePlan(result.plan, { baseline: context.plan }).ok).toBe(true);
    },
  },
  {
    name: "added session lands on the requested free day and validates",
    async check() {
      const context = makeContext("I can train an extra day this week");
      const anchor = allSessions(context.plan).find(s => s.type !== "RACE" && !s.done)!;
      const d = new Date(anchor.date + "T00:00:00");
      d.setDate(d.getDate() + 1);
      const date = ymd(d);
      const result = await run(context, [
        [{ name: "add_session", input: { date, type: "EASY", km: 5 } }],
        [],
      ]);
      expect(result.status).toBe("proposed");
      const added = allSessions(result.plan!).filter(s => s.id.startsWith("coach-add-"));
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({ date, type: "EASY", km: 5 });
      expect(validatePlan(result.plan, { baseline: context.plan }).ok).toBe(true);
    },
  },
  {
    name: "increase_session_distance lengthens a session and validates",
    async check() {
      const context = makeContext("these easy runs are way too short, I already run 8k easy");
      const target = allSessions(context.plan).find(s => s.type === "EASY" && !s.done)!;
      const result = await run(context, [
        [{ name: "increase_session_distance", input: { session_id: target.id, factor: 1.4 } }],
        [],
      ]);
      expect(result.status).toBe("proposed");
      expect(result.changed).toBe(true);
      const after = allSessions(result.plan!).find(s => s.id === target.id)!;
      expect(after.km).toBeGreaterThan(target.km);
      expect(validatePlan(result.plan, { baseline: context.plan }).ok).toBe(true);
    },
  },
  {
    name: "increase_session_distance is blocked when pain context is present",
    async check() {
      const context = makeContext("my knee hurts but the easy runs are too short anyway");
      const target = allSessions(context.plan).find(s => s.type === "EASY" && !s.done)!;
      const result = await run(context, [
        [{ name: "increase_session_distance", input: { session_id: target.id, factor: 1.4 } }],
        [],
      ]);
      expect(result.changed).toBe(false);
      expect(allSessions(result.plan!).find(s => s.id === target.id)!.km).toBe(target.km);
    },
  },
  {
    name: "increase_session_distance is blocked after a missed week",
    async check() {
      const context = makeContext("I missed a whole week, can you make the next runs longer to catch up?");
      const target = allSessions(context.plan).find(s => s.type === "EASY" && !s.done)!;
      const result = await run(context, [
        [{ name: "increase_session_distance", input: { session_id: target.id, factor: 1.4 } }],
        [],
      ]);
      expect(result.changed).toBe(false);
      expect(allSessions(result.plan!).find(s => s.id === target.id)!.km).toBe(target.km);
    },
  },
  {
    name: "add_session is blocked when Spanish pain context is present",
    async check() {
      // Same add as the "free day" case, but the runner reports knee pain in
      // Spanish — the es safety keywords must make guardToolForContext block it.
      const context = makeContext("me duele la rodilla, ¿puedo entrenar un día extra?");
      const anchor = allSessions(context.plan).find(s => s.type !== "RACE" && !s.done)!;
      const d = new Date(anchor.date + "T00:00:00");
      d.setDate(d.getDate() + 1);
      const result = await run(context, [
        [{ name: "add_session", input: { date: ymd(d), type: "EASY", km: 5 } }],
        [],
      ]);
      expect(result.status).toBe("proposed");
      expect(result.changed).toBe(false);
      expect(allSessions(result.plan!).some(s => s.id.startsWith("coach-add-"))).toBe(false);
    },
  },
  {
    name: "add_session is blocked when French pain context is present (accented)",
    async check() {
      // Accented pain/illness words must be caught — earlier the ASCII \b
      // boundaries broke on "fièvre"/"malgré" and let this slip past.
      const context = makeContext("j'ai de la fièvre et je cours malgré la douleur, puis-je m'entraîner un jour de plus ?");
      const anchor = allSessions(context.plan).find(s => s.type !== "RACE" && !s.done)!;
      const d = new Date(anchor.date + "T00:00:00");
      d.setDate(d.getDate() + 1);
      const result = await run(context, [
        [{ name: "add_session", input: { date: ymd(d), type: "EASY", km: 5 } }],
        [],
      ]);
      expect(result.status).toBe("proposed");
      expect(result.changed).toBe(false);
      expect(allSessions(result.plan!).some(s => s.id.startsWith("coach-add-"))).toBe(false);
    },
  },
  {
    name: "reply-language line is injected for es/fr and absent for en",
    check() {
      const base = { plan: buildPlan(weeksOut(18), 6600, SESSIONS, 21.1, 0, {}), recentRuns: [], today: ymd(new Date()), goal: {}, report: "hola" };
      expect(buildMessages({ ...base, replyLanguage: "es" }, [], null)[0].content).toContain("Spanish");
      expect(buildMessages({ ...base, replyLanguage: "fr" }, [], null)[0].content).toContain("French");
      expect(buildMessages({ ...base, replyLanguage: "en" }, [], null)[0].content).not.toContain("REPLY LANGUAGE");
    },
  },
  {
    name: "add_session inside the taper is refused by the tool, plan unchanged",
    async check() {
      const context = makeContext("add one more hard session before the race");
      const d = new Date(context.plan.raceDate + "T00:00:00");
      d.setDate(d.getDate() - 7);
      const result = await run(context, [
        [{ name: "add_session", input: { date: ymd(d), type: "EASY", km: 5 } }],
        [],
      ]);
      expect(result.status).toBe("proposed");
      expect(result.changed).toBe(false);
      expect(result.plan).toEqual(context.plan);
    },
  },
  {
    name: "get_run_detail digest reaches the model, is audited, and stays out of toolCalls",
    async check() {
      const context = makeContext("why was my heart rate so high on that hilly run?");
      context.recentRuns = [{ id: "run-1", date: context.recentRuns[0].date, type: "EASY", km: 6, durationSec: 6 * 380, hasDetail: true }];
      const digest = { runId: "run-1", splits: [{ km: 1, paceSecPerKm: 372, elevGainM: 24, avgHr: 158 }], notes: [] };
      const fetched: string[] = [];
      const inner = scriptedModel([[{ name: "get_run_detail", input: { run_id: "run-1" } }], []]);
      let secondCallMessages: { role: string; content: unknown }[] = [];
      const result = await generateProposal({
        baseline: context.plan,
        context,
        callModel: async (messages: { role: string; content: unknown }[]) => {
          if (fetched.length) secondCallMessages = messages;
          return inner();
        },
        fetchRunDetail: async (runId: string) => { fetched.push(runId); return digest; },
      });
      expect(result.status).toBe("proposed");
      expect(result.changed).toBe(false);
      expect(fetched).toEqual(["run-1"]);
      expect(result.toolCalls).toEqual([]);
      expect(result.runDetailFetches).toEqual([{ runId: "run-1", digest }]);
      // The digest JSON must have been fed back to the model as a tool_result.
      // Double-escaped: the digest is JSON inside a tool_result string.
      const feedback = JSON.stringify(secondCallMessages);
      expect(feedback).toContain('\\"avgHr\\":158');
      expect(feedback).not.toContain("is_error");
    },
  },
  {
    name: "get_run_detail with an unknown id answers without touching the fetcher",
    async check() {
      const context = makeContext("analyse my run from last month");
      let fetches = 0;
      const result = await generateProposal({
        baseline: context.plan,
        context,
        callModel: scriptedModel([[{ name: "get_run_detail", input: { run_id: "nope" } }], []]),
        fetchRunDetail: async () => { fetches++; return {}; },
      });
      expect(result.status).toBe("proposed");
      expect(fetches).toBe(0);
      expect(result.runDetailFetches).toEqual([]);
    },
  },
  {
    name: "get_run_detail beyond the per-round budget returns DETAIL_BUDGET as is_error",
    async check() {
      const context = makeContext("compare all my recent runs in detail");
      context.recentRuns = ["a", "b", "c", "d"].map(id =>
        ({ id, date: context.today, type: "EASY", km: 5, durationSec: 1500, hasDetail: true }));
      let secondCallMessages: { role: string; content: unknown }[] = [];
      let calls = 0;
      const inner = scriptedModel([
        ["a", "b", "c", "d"].map(id => ({ name: "get_run_detail", input: { run_id: id } })),
        [],
      ]);
      const result = await generateProposal({
        baseline: context.plan,
        context,
        callModel: async (messages: { role: string; content: unknown }[]) => {
          if (calls++ === 1) secondCallMessages = messages;
          return inner();
        },
        fetchRunDetail: async (runId: string) => ({ runId }),
      });
      expect(result.status).toBe("proposed");
      expect(result.runDetailFetches).toHaveLength(3);
      expect(JSON.stringify(secondCallMessages)).toContain("DETAIL_BUDGET");
    },
  },
  {
    name: "an unknown id after the budget is spent answers accurately, not DETAIL_BUDGET",
    async check() {
      const context = makeContext("compare my runs, then one more");
      context.recentRuns = ["a", "b", "c"].map(id =>
        ({ id, date: context.today, type: "EASY", km: 5, durationSec: 1500, hasDetail: true }));
      let secondCallMessages: { role: string; content: unknown }[] = [];
      let calls = 0;
      const inner = scriptedModel([
        [...["a", "b", "c"].map(id => ({ name: "get_run_detail", input: { run_id: id } })),
          { name: "get_run_detail", input: { run_id: "nope" } }],
        [],
      ]);
      const result = await generateProposal({
        baseline: context.plan,
        context,
        callModel: async (messages: { role: string; content: unknown }[]) => {
          if (calls++ === 1) secondCallMessages = messages;
          return inner();
        },
        fetchRunDetail: async (runId: string) => ({ runId }),
      });
      expect(result.status).toBe("proposed");
      expect(result.runDetailFetches).toHaveLength(3);
      const feedback = JSON.stringify(secondCallMessages);
      expect(feedback).toContain("Unknown run id");
      expect(feedback).not.toContain("DETAIL_BUDGET");
    },
  },
  {
    name: "a read-only-only round that exhausts the model-call budget still surfaces its answer",
    async check() {
      const context = makeContext("deep-dive my runs forever");
      context.recentRuns = [{ id: "run-1", date: context.today, type: "EASY", km: 6, durationSec: 2280, hasDetail: true }];
      // scriptedModel repeats its last turn, so the model NEVER stops calling
      // get_run_detail — MAX_MODEL_CALLS is exhausted without a tool-free turn.
      const result = await generateProposal({
        baseline: context.plan,
        context,
        callModel: scriptedModel([[{ name: "get_run_detail", input: { run_id: "run-1" } }]]),
        fetchRunDetail: async (runId: string) => ({ runId }),
      });
      // The old terminal gate keyed only on toolCalls.length and misreported
      // this as no_valid_adjustment, discarding the coach's text.
      expect(result.status).toBe("proposed");
      expect(result.changed).toBe(false);
      expect(result.plan).toEqual(context.plan);
      expect(result.rationale).toBeTruthy();
      expect(result.runDetailFetches).toHaveLength(3);
    },
  },
  {
    name: "mock model routes pain-plus-analysis phrasing to the injury path, not a detail fetch",
    async check() {
      const context = makeContext("my knee hurt on that run, can you analyse my run?");
      const resp = await createMockModel(context)([{ role: "user", content: context.report }]);
      const names = resp.content.filter((b: { type: string }) => b.type === "tool_use")
        .map((b: { name: string }) => b.name);
      expect(names).toContain("convert_to_cross_training");
      expect(names).not.toContain("get_run_detail");
    },
  },
  {
    name: "get_run_detail without an injected fetcher degrades to a plain answer",
    async check() {
      const context = makeContext("how did my last run go?");
      context.recentRuns = [{ id: "run-1", date: context.today, type: "EASY", km: 6, durationSec: 2280, hasDetail: true }];
      const result = await run(context, [
        [{ name: "get_run_detail", input: { run_id: "run-1" } }],
        [],
      ], "From the summary alone: that run looks steady.");
      expect(result.status).toBe("proposed");
      expect(result.changed).toBe(false);
      expect((result as { runDetailFetches?: unknown[] }).runDetailFetches).toEqual([]);
    },
  },
  {
    name: "invalid tool call every turn exhausts safely",
    async check() {
      const context = makeContext("force an unsafe change");
      const week = buildWeek(context.plan);
      const result = await run(context, [
        [{ name: "reduce_week_volume", input: { week_number: week.weekNumber, factor: 2 } }],
      ]);
      expect(result.status).toBe("no_valid_adjustment");
      expect(result.plan).toBeUndefined();
    },
  },
  {
    name: "invalid then valid recovers within the loop",
    async check() {
      const context = makeContext("first try is invalid, then safe");
      const week = buildWeek(context.plan);
      const result = await run(context, [
        [{ name: "reduce_week_volume", input: { week_number: week.weekNumber, factor: 2 } }],
        [{ name: "reduce_week_volume", input: { week_number: week.weekNumber, factor: 0.7 } }],
        [],
      ]);
      expect(result.status).toBe("proposed");
      expect(weekVol(result.plan!.weeks.find(w => w.weekNumber === week.weekNumber)!)).toBeLessThan(weekVol(week));
      expect(validatePlan(result.plan, { baseline: context.plan }).ok).toBe(true);
    },
  },
];

let passed = 0;

describe("coach-agent offline eval", () => {
  it.each(cases)("$name", async ({ check }) => {
    await check();
    passed++;
  });

  afterAll(() => {
    console.log(`\ncoach-agent offline eval: ${passed}/${cases.length} passed`);
  });
});
