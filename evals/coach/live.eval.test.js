// Live eval runner for the coach agent. Drives the REAL generateProposal loop
// (engine + tools + validator — exactly what the edge function runs) against
// the real Anthropic API, replays every scenario in scenarios.mjs, grades the
// outcome, and writes a JSON report to evals/coach/results/.
//
//   ANTHROPIC_API_KEY=sk-ant-... npm run eval:live
//   MISTRAL_API_KEY=...  COACH_EVAL_MODEL=mistral-large-latest npm run eval:live
//
// Env:
//   ANTHROPIC_API_KEY   required for a live run on a claude-* model
//   MISTRAL_API_KEY     required instead when COACH_EVAL_MODEL is a Mistral
//                       model (mistral*/magistral*/... — see mistral.mjs)
//   COACH_EVAL_MODEL    default claude-sonnet-5 (prod default — compare
//                       candidates by re-running with a different value,
//                       e.g. mistral-large-latest)
//   COACH_EVAL_TRIALS   trials per scenario, default 1
//   COACH_EVAL_SCENARIOS optional comma-separated scenario ids to run
//   COACH_EVAL_MOCK=1   run the harness through the MOCK_LLM scripts instead
//                       (free plumbing check; quality scores are meaningless)
//
// Grading tiers (see graders.mjs): SAFETY failures fail the vitest run;
// QUALITY misses only lower the reported score.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { generateProposal, SYSTEM_PROMPT } from "../../supabase/functions/_shared/coach/engine.mjs";
import { createMockModel } from "../../supabase/functions/_shared/coach/mock.mjs";
import { isMistralModel, makeMistralModel } from "../../supabase/functions/_shared/coach/mistral.mjs";
import { makeLiveModel } from "./anthropic.mjs";
import { SCENARIOS, makeFixture } from "./scenarios.mjs";
import { UNIVERSAL_SAFETY } from "./graders.mjs";

const MOCK = Boolean(process.env.COACH_EVAL_MOCK);
const MODEL = MOCK ? "mock" : (process.env.COACH_EVAL_MODEL || "claude-sonnet-5");
// The provider (and therefore the required key) follows the model name,
// mirroring the edge function's makeCallModel routing.
const MISTRAL = !MOCK && isMistralModel(MODEL);
const API_KEY = MISTRAL ? process.env.MISTRAL_API_KEY : process.env.ANTHROPIC_API_KEY;
const API_KEY_NAME = MISTRAL ? "MISTRAL_API_KEY" : "ANTHROPIC_API_KEY";
const TRIALS = Math.max(1, Number(process.env.COACH_EVAL_TRIALS || 1));
const REQUESTED_SCENARIOS = (process.env.COACH_EVAL_SCENARIOS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const SCENARIO_SET = new Set(REQUESTED_SCENARIOS);
const SELECTED_SCENARIOS = REQUESTED_SCENARIOS.length
  ? SCENARIOS.filter(s => SCENARIO_SET.has(s.id))
  : SCENARIOS;
const UNKNOWN_SCENARIOS = REQUESTED_SCENARIOS.filter(id => !SCENARIOS.some(s => s.id === id));

const runnable = MOCK || Boolean(API_KEY);
if (!runnable) {
  console.warn(`\ncoach live eval: set ${API_KEY_NAME} (or COACH_EVAL_MOCK=1) to run — skipping.\n`);
}
if (UNKNOWN_SCENARIOS.length) {
  throw new Error(`Unknown COACH_EVAL_SCENARIOS id(s): ${UNKNOWN_SCENARIOS.join(", ")}. Valid ids: ${SCENARIOS.map(s => s.id).join(", ")}`);
}

const records = [];

// Stub for the engine's injected get_run_detail fetcher — evals have no DB, so
// every hasDetail run resolves to this canned digest: an honest "HR climbed on
// the hills" pattern (rising elevation, drifting HR at steady pace) shaped
// exactly like runDigest.mjs output.
const FIXTURE_DIGEST = {
  date: "(fixture)", type: "EASY", distKm: 8, durationSec: 8 * 372, avgHr: 158, maxHr: 181, effort: 3,
  elevGainM: 210,
  splits: [
    { k: 1, p: 370, e: 8, h: 141 }, { k: 2, p: 372, e: 12, h: 146 }, { k: 3, p: 378, e: 45, h: 162 },
    { k: 4, p: 381, e: 52, h: 171 }, { k: 5, p: 375, e: 38, h: 168 }, { k: 6, p: 368, e: 20, h: 158 },
    { k: 7, p: 366, e: 18, h: 155 }, { k: 8, p: 362, e: 17, h: 152 },
  ],
  hrZones: [
    { zone: "Z1", label: "Recovery", sec: 180, pctTime: 6 }, { zone: "Z2", label: "Aerobic Base", sec: 660, pctTime: 22 },
    { zone: "Z3", label: "Aerobic Tempo", sec: 900, pctTime: 30 }, { zone: "Z4", label: "Threshold", sec: 960, pctTime: 32 },
    { zone: "Z5", label: "VO2 Max", sec: 276, pctTime: 9 },
  ],
  series: Array.from({ length: 40 }, (_, i) => ({
    d: Math.round((i + 1) * 0.2 * 100) / 100, p: 365 + Math.round(15 * Math.sin(i / 6)),
    e: 100 + Math.round(60 * Math.sin(i / 5)), h: 140 + Math.round(20 * Math.sin(i / 5 - 0.5)),
  })),
  notes: [],
};
const makeFetchRunDetail = (context) => async (runId) => {
  const run = (context.recentRuns || []).find(r => r.id === runId);
  if (!run || !run.hasDetail) return { unavailable: "no detailed recording for this run" };
  return { ...FIXTURE_DIGEST, runId };
};

function makeCallModel(context) {
  const observedTools = [];
  const inner = MOCK
    ? createMockModel(context)
    : MISTRAL
    ? makeMistralModel({ apiKey: API_KEY, model: MODEL, systemPrompt: SYSTEM_PROMPT })
    : makeLiveModel({ apiKey: API_KEY, model: MODEL, systemPrompt: SYSTEM_PROMPT });
  const callModel = async (messages, tools) => {
    const resp = await inner(messages, tools);
    for (const b of resp.content) if (b.type === "tool_use") observedTools.push(b.name);
    return resp;
  };
  return { callModel, observedTools };
}

describe.skipIf(!runnable)(`coach live eval (${MODEL}, ${TRIALS} trial(s)/scenario)`, () => {
  it.each(SELECTED_SCENARIOS)("$id", async (scenario) => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const { context, baseline } = makeFixture(scenario);
      const { callModel, observedTools } = makeCallModel(context);
      const t0 = Date.now();
      const result = await generateProposal({ baseline, context, callModel, fetchRunDetail: makeFetchRunDetail(context) });
      const ms = Date.now() - t0;

      const outcome = { result, baseline, context, observedTools };
      const safety = [...UNIVERSAL_SAFETY, ...scenario.safety].map(fn => fn(outcome));
      const quality = scenario.quality.map(fn => fn(outcome));

      records.push({
        scenario: scenario.id,
        trial,
        status: result.status,
        changed: result.changed ?? null,
        toolCalls: result.toolCalls.map(t => t.name),
        memorySuggestions: result.memorySuggestions || [],
        observedTools,
        rationale: result.rationale,
        usage: result.usage,
        ms,
        safety,
        quality,
      });

      // Safety is the gate: any miss fails the run, with the grader's detail.
      for (const s of safety) {
        expect(s.pass, `[${scenario.id} trial ${trial}] SAFETY ${s.name}: ${s.detail}`).toBe(true);
      }
    }
  });

  afterAll(() => {
    if (!records.length) return;
    const dir = join(dirname(fileURLToPath(import.meta.url)), "results");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const totals = records.reduce((t, r) => ({
      input: t.input + (r.usage?.input_tokens || 0),
      output: t.output + (r.usage?.output_tokens || 0),
    }), { input: 0, output: 0 });
    const qualityOf = (rs) => {
      const all = rs.flatMap(r => r.quality);
      return all.length ? all.filter(q => q.pass).length / all.length : 1;
    };
    const report = {
      model: MODEL,
      mock: MOCK,
      trials: TRIALS,
      scenarios: SELECTED_SCENARIOS.map(s => s.id),
      at: new Date().toISOString(),
      safetyPassRate: records.flatMap(r => r.safety).filter(s => s.pass).length /
        Math.max(1, records.flatMap(r => r.safety).length),
      qualityScore: qualityOf(records),
      tokens: totals,
      records,
    };
    const file = join(dir, `coach-eval-${stamp}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));

    const rows = SELECTED_SCENARIOS.map(s => {
      const rs = records.filter(r => r.scenario === s.id);
      if (!rs.length) return null;
      const safetyOk = rs.every(r => r.safety.every(x => x.pass));
      const q = rs.flatMap(r => r.quality);
      const misses = q.filter(x => !x.pass).map(x => x.name);
      return `  ${s.id.padEnd(18)} safety ${safetyOk ? "OK  " : "FAIL"}  quality ${q.filter(x => x.pass).length}/${q.length}` +
        `  status ${rs.map(r => r.status + (r.changed ? "+edit" : "")).join(",")}` +
        (misses.length ? `  missed: ${[...new Set(misses)].join(", ")}` : "");
    }).filter(Boolean);

    // process.stdout directly — vitest's reporter swallows console.log.
    process.stdout.write([
      "",
      `coach live eval — model ${MODEL}${MOCK ? " (MOCK — quality scores not meaningful)" : ""}, ${TRIALS} trial(s)/scenario${REQUESTED_SCENARIOS.length ? `, scenarios ${SELECTED_SCENARIOS.map(s => s.id).join(",")}` : ""}`,
      ...rows,
      `  safety ${(report.safetyPassRate * 100).toFixed(0)}% (must be 100)  quality ${(report.qualityScore * 100).toFixed(0)}%  tokens in/out ${totals.input}/${totals.output}`,
      `  report: ${file}`,
      "",
    ].join("\n") + "\n");
  });
});
