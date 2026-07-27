// Golden cases for the coach agent — the day-one eval set. Each case replays a
// situation (plan + run history + report) through the REAL proposal loop
// (engine.mjs: tool execution + validate-and-retry) with the MOCK_LLM scripts
// standing in for the model, and asserts the adaptation PROPERTY, not exact
// output. The same properties apply when a live model runs the loop; the
// propose/confirm audit log (agent_rounds) grows this dataset in production.

import { describe, it, expect } from "vitest";
// @ts-expect-error Shared edge-function ESM has no TypeScript declarations yet.
import { buildMessages, generateProposal, MAX_VALIDATOR_RETRIES, MAX_MODEL_CALLS, SYSTEM_PROMPT } from "../../supabase/functions/_shared/coach/engine.mjs";
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
};
type TestWeek = { weekNumber: number; startDate: string; sessions: TestSession[] };
type TestPlan = { raceDate: string; targetPace: number; weeks: TestWeek[] };
type ModelMessage = { role: string; content: string };
type ProposalResult = {
  status: string;
  changed: boolean;
  plan?: TestPlan;
  rationale: string;
  toolCalls: { name: string }[];
  memorySuggestions: { text: string }[];
  usage: { input_tokens: number };
};

const generate = generateProposal as (input: Record<string, unknown>) => Promise<ProposalResult>;

const weeksOut = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n * 7); return ymd(d); };

function makeContext(report: string) {
  const plan = buildPlan(weeksOut(16), 6600, [{ dayOffset: 2, minutes: 45 }, { dayOffset: 6, minutes: 90 }], 21.1, 0, {}) as TestPlan;
  return {
    plan,
    report,
    today: ymd(new Date()),
    recentRuns: [{ date: ymd(new Date(Date.now() - 3 * 86400000)), type: "EASY", km: 6, durationSec: 6 * 380 }],
    goal: { raceDate: plan.raceDate, distanceKm: 21.1, goalSec: 6600 },
    goalSec: 6600, distanceKm: 21.1, raceDate: plan.raceDate, targetPace: plan.targetPace,
  };
}

const run = (report: string) => {
  const context = makeContext(report);
  return generate({
    baseline: context.plan, context, callModel: createMockModel(context),
  }).then(result => ({ context, result }));
};

const hardKm = (plan: TestPlan) => plan.weeks.flatMap(w => w.sessions)
  .filter(s => ["TEMPO", "INTERVALS", "LONG"].includes(s.type) && !s.done)
  .reduce((t, s) => t + s.km, 0);
const weekTotal = (plan: TestPlan, n: number) => plan.weeks.find(w => w.weekNumber === n)
  ?.sessions.reduce((t, s) => t + (s.type === "RACE" ? 0 : s.km), 0) ?? 0;

describe("golden cases (MOCK_LLM)", () => {
  it("knee pain → intensity never increases; impact comes out; plan validates", async () => {
    const { context, result } = await run("my knee hurts after yesterday's run");
    expect(result.status).toBe("proposed");
    expect(result.changed).toBe(true);
    expect(hardKm(result.plan!)).toBeLessThan(hardKm(context.plan));
    const walks = result.plan!.weeks.flatMap(w => w.sessions).filter(s => s.type === "WALK");
    expect(walks.length).toBeGreaterThan(0);
    expect(validatePlan(result.plan, { baseline: context.plan }).ok).toBe(true);
    expect(result.usage.input_tokens).toBeGreaterThan(0); // cost is recorded
  });

  it("missed week → resume gently, never 'make up' volume", async () => {
    const { context, result } = await run("I missed the whole week, work exploded");
    expect(result.status).toBe("proposed");
    for (const w of result.plan!.weeks) {
      expect(weekTotal(result.plan!, w.weekNumber))
        .toBeLessThanOrEqual(weekTotal(context.plan, w.weekNumber) + 0.01);
    }
    expect(validatePlan(result.plan, { baseline: context.plan }).ok).toBe(true);
  });

  it("free day → adds one modest EASY session; ramp rule still holds", async () => {
    const { context, result } = await run("I have a free day Thursday — could you add an extra easy run?");
    expect(result.status).toBe("proposed");
    expect(result.changed).toBe(true);
    const added = result.plan!.weeks.flatMap(w => w.sessions).filter(s => s.id.startsWith("coach-add-"));
    expect(added).toHaveLength(1);
    expect(added[0]!.type).toBe("EASY");
    expect(validatePlan(result.plan, { baseline: context.plan }).ok).toBe(true);
  });

  it("advice question → answer without touching the plan", async () => {
    const { context, result } = await run("what should I eat before the race?");
    expect(result.status).toBe("proposed");
    expect(result.changed).toBe(false);
    expect(result.plan).toEqual(context.plan);
    expect(result.rationale.length).toBeGreaterThan(0);
  });

  it("validator never satisfied → bounded retries, then no_valid_adjustment (never a broken plan)", async () => {
    const { result } = await run("force-invalid: stack my hard days together");
    expect(result.status).toBe("no_valid_adjustment");
    expect(result.plan).toBeUndefined(); // an invalid plan is never surfaced
    expect(MAX_VALIDATOR_RETRIES).toBeGreaterThan(0);
  });

  it("MAX_MODEL_CALLS exhaustion with an already-valid plan is proposed, not discarded", async () => {
    // A model that keeps issuing further (individually valid, effectively
    // idempotent) tool calls instead of ever stopping to summarize must not
    // have its legitimate work thrown away under the "no adjustment" fate —
    // only a genuinely invalid working plan should end up there.
    const context = makeContext("please double-check this for me");
    const target = context.plan.weeks.flatMap(w => w.sessions).find(s => s.type !== "RACE" && !s.done)!;
    let calls = 0;
    const callModel = async () => {
      calls++;
      return {
        content: [{ type: "tool_use", id: "t" + calls, name: "convert_to_cross_training", input: { session_id: target.id } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
    };
    const result = await generate({ baseline: context.plan, context, callModel });
    expect(calls).toBe(MAX_MODEL_CALLS);
    expect(result.status).toBe("proposed");
    expect(result.plan!.weeks.flatMap(w => w.sessions).find(s => s.id === target.id)!.type).toBe("WALK");
    expect(validatePlan(result.plan, { baseline: context.plan }).ok).toBe(true);
  });

  it("critique round: history + feedback reach the model in order", async () => {
    const context = makeContext("my knee hurts");
    const seen: string[] = [];
    const callModel = async (messages: ModelMessage[]) => {
      seen.push(messages.map(m => m.role).join(","));
      return { content: [{ type: "text", text: "Understood — keeping it as is." }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 } };
    };
    const result = await generate({
      baseline: context.plan, context,
      history: [{ user_feedback: null, rationale: "Eased week 2.", tool_calls: [{ name: "reduce_week_volume", input: { week_number: 2, factor: 0.7 } }] }],
      message: "actually only reduce the long run, keep the tempo",
      callModel,
    });
    expect(result.status).toBe("proposed");
    // report → assistant round 0 → new critique
    expect(seen[0]).toBe("user,assistant,user");
  });

  it("critique round starts from the latest proposal, not the saved baseline", async () => {
    const context = makeContext("my knee hurts");
    const target = context.plan.weeks.flatMap(w => w.sessions).find(s => s.type !== "RACE" && !s.done)!;
    const proposed = structuredClone(context.plan);
    proposed.weeks.flatMap(w => w.sessions).find(s => s.id === target.id)!.type = "WALK";
    const callModel = async () => ({
      content: [{ type: "text", text: "Keeping the earlier change." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10 },
    });

    const result = await generate({
      baseline: context.plan,
      context: { ...context, plan: proposed },
      history: [{ user_feedback: null, rationale: "Converted one session to WALK.", tool_calls: [{ name: "convert_to_cross_training", input: { session_id: target.id } }] }],
      message: "also shorten Sunday",
      callModel,
    });

    expect(result.status).toBe("proposed");
    expect(result.changed).toBe(true);
    expect(result.plan!.weeks.flatMap(w => w.sessions).find(s => s.id === target.id)!.type).toBe("WALK");
  });

  it("buildMessages includes user-visible coach memory", () => {
    const context = { ...makeContext("my knee hurts"), userContext: { notes: "2026-07-06: Avoids downhill repeats." } };
    const messages = buildMessages(context, [], null);
    expect(messages[0].content).toContain("USER-VISIBLE COACH MEMORY");
    expect(messages[0].content).toContain("Avoids downhill repeats");
  });

  it("buildMessages includes the runner's age only when known", () => {
    const withAge = buildMessages({ ...makeContext("my knee hurts"), runnerAge: 61 }, [], null);
    expect(withAge[0].content).toContain("RUNNER AGE: 61");
    // Ageless contexts (all pre-existing fixtures) stay byte-identical.
    const without = buildMessages(makeContext("my knee hurts"), [], null);
    expect(without[0].content).not.toContain("RUNNER AGE");
  });

  it("system prompt asks about resolved memory pain before increasing load", () => {
    expect(SYSTEM_PROMPT).toContain("ask whether the pain has gone away");
    expect(SYSTEM_PROMPT).toContain("before increasing load");
  });

  it("system prompt prefers a modest add_session for explicit free-day requests", () => {
    expect(SYSTEM_PROMPT).toContain("try one modest add_session");
    expect(SYSTEM_PROMPT).toContain("before reframing it as a goal-settings issue");
  });

  // Production regression (2026-07, mistral-large-latest): an informational
  // round answered a "how was my run" question, then announced "One Small
  // Adjustment Made ... I've reduced Week 5's volume" having made ZERO tool
  // calls, so nothing was proposed and nothing was confirmable. The pre-send
  // self-check and the no-tool-calls summary rule below exist to stop that.
  it("system prompt forbids past-tense change claims without tool calls", () => {
    expect(SYSTEM_PROMPT).toContain("Past-tense claims are the trap");
    expect(SYSTEM_PROMPT).toContain("never write one when you made no tool calls");
    expect(SYSTEM_PROMPT).toContain("Never leave the runner believing their plan moved when it did not");
    expect(SYSTEM_PROMPT).toContain("If you made no tool calls in this response, say plainly that nothing in the plan has changed");
  });

  it("memory-only tool suggestions do not mark the plan changed", async () => {
    const context = makeContext("please remember I prefer Sunday long runs");
    let calls = 0;
    const callModel = async () => {
      calls++;
      if (calls === 1) return {
        content: [{ type: "tool_use", id: "mem1", name: "remember_runner_context", input: { memory: "Prefers Sunday long runs." } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
      return { content: [{ type: "text", text: "I'll keep that preference in mind if you save it." }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } };
    };
    const result = await generate({ baseline: context.plan, context, callModel });
    expect(result.status).toBe("proposed");
    expect(result.changed).toBe(false);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.memorySuggestions.map(s => s.text)).toEqual([`${context.today}: Prefers Sunday long runs.`]);
  });

  it("memory-only tool calls do not satisfy the plan-tool max-call fallback", async () => {
    const context = makeContext("remember that I prefer Sunday long runs");
    let calls = 0;
    const callModel = async () => {
      calls++;
      return {
        content: [{ type: "tool_use", id: "mem" + calls, name: "remember_runner_context", input: { memory: "Prefers Sunday long runs." } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
    };
    const result = await generate({ baseline: context.plan, context, callModel });
    expect(calls).toBe(MAX_MODEL_CALLS);
    expect(result.status).toBe("no_valid_adjustment");
    expect(result.plan).toBeUndefined();
  });

  it("duplicate memory suggestions are rejected deterministically", async () => {
    const context = { ...makeContext("remember my long-run preference"), userContext: { notes: "2026-07-01: Prefers Sunday long runs." } };
    let calls = 0;
    const callModel = async () => {
      calls++;
      if (calls === 1) return {
        content: [{ type: "tool_use", id: "mem1", name: "remember_runner_context", input: { memory: "Prefers Sunday long runs." } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
      return { content: [{ type: "text", text: "That is already saved." }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } };
    };
    const result = await generate({ baseline: context.plan, context, callModel });
    expect(result.status).toBe("proposed");
    expect(result.memorySuggestions).toEqual([]);
  });

  it("context guard rejects add_session during pain even when structurally valid", async () => {
    const context = makeContext("my knee hurts but I have a free day Thursday");
    let calls = 0;
    const callModel = async () => {
      calls++;
      if (calls === 1) return {
        content: [{ type: "tool_use", id: "add1", name: "add_session", input: { date: context.plan.weeks[0].startDate, type: "EASY", km: 4 } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
      return { content: [{ type: "text", text: "I won't add training while your knee hurts." }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } };
    };
    const result = await generate({ baseline: context.plan, context, callModel });
    expect(result.status).toBe("proposed");
    expect(result.changed).toBe(false);
    expect(result.toolCalls).toEqual([]);
  });

  it("context guard rejects add_session as make-up volume after a missed week", async () => {
    const context = makeContext("I missed the whole week, can I add an extra easy run?");
    let calls = 0;
    const callModel = async () => {
      calls++;
      if (calls === 1) return {
        content: [{ type: "tool_use", id: "add1", name: "add_session", input: { date: context.plan.weeks[0].startDate, type: "EASY", km: 4 } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
      return { content: [{ type: "text", text: "A missed week is gone; resume gently instead." }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } };
    };
    const result = await generate({ baseline: context.plan, context, callModel });
    expect(result.status).toBe("proposed");
    expect(result.changed).toBe(false);
    expect(result.toolCalls).toEqual([]);
  });

  it("context guard rejects harder swaps during pain", async () => {
    const context = makeContext("my calf is sore but I want to push harder");
    const easy = context.plan.weeks.flatMap(w => w.sessions).find(s => s.type === "EASY" && !s.done)!;
    let calls = 0;
    const callModel = async () => {
      calls++;
      if (calls === 1) return {
        content: [{ type: "tool_use", id: "swap1", name: "swap_session", input: { session_id: easy.id, new_type: "TEMPO" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
      return { content: [{ type: "text", text: "No intensity while your calf is sore." }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } };
    };
    const result = await generate({ baseline: context.plan, context, callModel });
    expect(result.status).toBe("proposed");
    expect(result.changed).toBe(false);
    expect(result.toolCalls).toEqual([]);
  });

  it("context guard allows add_session after the latest message says pain resolved", async () => {
    const context = makeContext("my knee hurt earlier this week");
    let calls = 0;
    const callModel = async () => {
      calls++;
      if (calls === 1) return {
        content: [{ type: "tool_use", id: "add1", name: "add_session", input: { date: context.plan.weeks[0].startDate, type: "EASY", km: 4 } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
      return { content: [{ type: "text", text: "Added a modest easy run now that the pain has resolved." }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } };
    };
    const result = await generate({
      baseline: context.plan,
      context,
      history: [{ user_feedback: null, rationale: "Reduced load while your knee hurt.", tool_calls: [] }],
      message: "The knee pain is gone and I feel normal now; I have a free day.",
      callModel,
    });
    expect(result.status).toBe("proposed");
    expect(result.changed).toBe(true);
    expect(result.toolCalls.map(t => t.name)).toEqual(["add_session"]);
  });

  it("context guard treats unresolved pain from Coach memory as load-increase risk", async () => {
    const context = {
      ...makeContext("I have a free day Thursday — could you add an extra easy run?"),
      userContext: { notes: "2026-07-01: Recurring Achilles soreness after hills." },
    };
    let calls = 0;
    const callModel = async () => {
      calls++;
      if (calls === 1) return {
        content: [{ type: "tool_use", id: "add1", name: "add_session", input: { date: context.plan.weeks[0].startDate, type: "EASY", km: 4 } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
      return { content: [{ type: "text", text: "Before adding load, is the Achilles soreness gone?" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } };
    };
    const result = await generate({ baseline: context.plan, context, callModel });
    expect(result.status).toBe("proposed");
    expect(result.changed).toBe(false);
    expect(result.toolCalls).toEqual([]);
  });

  it("context guard allows load increases when latest message resolves Coach memory pain", async () => {
    const context = {
      ...makeContext("I have a free day Thursday — could you add an extra easy run?"),
      userContext: { notes: "2026-07-01: Recurring Achilles soreness after hills." },
    };
    let calls = 0;
    const callModel = async () => {
      calls++;
      if (calls === 1) return {
        content: [{ type: "tool_use", id: "add1", name: "add_session", input: { date: context.plan.weeks[0].startDate, type: "EASY", km: 4 } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
      return { content: [{ type: "text", text: "Added a modest easy run." }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } };
    };
    const result = await generate({
      baseline: context.plan,
      context,
      message: "The Achilles soreness is gone and I feel normal now; I have a free day.",
      callModel,
    });
    expect(result.status).toBe("proposed");
    expect(result.changed).toBe(true);
    expect(result.toolCalls.map(t => t.name)).toEqual(["add_session"]);
  });

  it("context guard does not treat negated recovery as resolved", async () => {
    const context = makeContext("my knee hurt earlier this week");
    let calls = 0;
    const callModel = async () => {
      calls++;
      if (calls === 1) return {
        content: [{ type: "tool_use", id: "add1", name: "add_session", input: { date: context.plan.weeks[0].startDate, type: "EASY", km: 4 } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
      return { content: [{ type: "text", text: "I won't add training until the pain is actually gone." }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } };
    };
    const result = await generate({
      baseline: context.plan,
      context,
      history: [{ user_feedback: null, rationale: "Reduced load while your knee hurt.", tool_calls: [] }],
      message: "The knee pain is not gone, but I have a free day.",
      callModel,
    });
    expect(result.status).toBe("proposed");
    expect(result.changed).toBe(false);
    expect(result.toolCalls).toEqual([]);
  });

  it("context guard does not treat not feeling normal as resolved", async () => {
    const context = makeContext("I had the flu last week");
    let calls = 0;
    const callModel = async () => {
      calls++;
      if (calls === 1) return {
        content: [{ type: "tool_use", id: "add1", name: "add_session", input: { date: context.plan.weeks[0].startDate, type: "EASY", km: 4 } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
      return { content: [{ type: "text", text: "Wait until you feel back to normal before adding load." }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } };
    };
    const result = await generate({
      baseline: context.plan,
      context,
      message: "I'm not feeling normal yet, but I have a free day.",
      callModel,
    });
    expect(result.status).toBe("proposed");
    expect(result.changed).toBe(false);
    expect(result.toolCalls).toEqual([]);
  });

  it("context guard does not confuse cold weather with illness", async () => {
    const context = makeContext("It's cold outside, but I feel normal and have a free day Thursday.");
    let calls = 0;
    const callModel = async () => {
      calls++;
      if (calls === 1) return {
        content: [{ type: "tool_use", id: "add1", name: "add_session", input: { date: context.plan.weeks[0].startDate, type: "EASY", km: 4 } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 5 },
      };
      return { content: [{ type: "text", text: "Added a modest easy run." }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } };
    };
    const result = await generate({ baseline: context.plan, context, callModel });
    expect(result.status).toBe("proposed");
    expect(result.changed).toBe(true);
    expect(result.toolCalls.map(t => t.name)).toEqual(["add_session"]);
  });
});
