// Contract tests for the coach agent's Mistral provider adapter
// (supabase/functions/_shared/coach/mistral.mjs). The engine speaks the
// Anthropic Messages shape; these tests pin the translation in both
// directions on exactly the turn shapes generateProposal produces, so a
// Mistral API drift or an adapter regression fails here instead of live.
import { describe, it, expect, vi } from "vitest";
// @ts-expect-error — plain ESM module shared with the Supabase edge function.
import { isMistralModel, toMistralTools, toMistralMessages, fromMistralResponse, makeMistralModel } from "../../supabase/functions/_shared/coach/mistral.mjs";

const SYSTEM = "You are the adjustment coach.";

describe("isMistralModel", () => {
  it("routes Mistral model families to the adapter and everything else away", () => {
    for (const m of ["mistral-large-latest", "mistral-medium-latest", "magistral-medium-latest", "ministral-8b-latest", "open-mixtral-8x22b", "Mistral-Large-3"]) {
      expect(isMistralModel(m)).toBe(true);
    }
    for (const m of ["claude-sonnet-5", "claude-haiku-4-5", "mock", "", undefined]) {
      expect(isMistralModel(m)).toBe(false);
    }
  });
});

describe("toMistralTools", () => {
  it("wraps Anthropic tool defs as OpenAI-style function tools, schema untouched", () => {
    const schema = { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] };
    const out = toMistralTools([{ name: "shift_workout", description: "Move a session.", input_schema: schema }]);
    expect(out).toEqual([
      { type: "function", function: { name: "shift_workout", description: "Move a session.", parameters: schema } },
    ]);
  });
});

describe("toMistralMessages", () => {
  it("converts the engine's full round shape: context turn, assistant tool_use echo, tool results + validator text", () => {
    const messages = [
      { role: "user", content: "CURRENT PLAN...\n\nRUNNER SAYS: knee pain" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Softening the intervals." },
          { type: "tool_use", id: "aB3xY9zQ1", name: "swap_session", input: { session_id: "s1", new_type: "EASY" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "aB3xY9zQ1", content: "Applied." },
          { type: "text", text: "All adjustments applied; the plan validates." },
        ],
      },
    ];
    expect(toMistralMessages(SYSTEM, messages)).toEqual([
      { role: "system", content: SYSTEM },
      { role: "user", content: "CURRENT PLAN...\n\nRUNNER SAYS: knee pain" },
      {
        role: "assistant",
        content: "Softening the intervals.",
        tool_calls: [{
          id: "aB3xY9zQ1",
          type: "function",
          function: { name: "swap_session", arguments: JSON.stringify({ session_id: "s1", new_type: "EASY" }) },
        }],
      },
      { role: "tool", tool_call_id: "aB3xY9zQ1", name: "swap_session", content: "Applied." },
      { role: "user", content: "All adjustments applied; the plan validates." },
    ]);
  });

  it("keeps an error tool_result's CODE: message text (Mistral has no is_error flag)", () => {
    const out = toMistralMessages(SYSTEM, [
      { role: "assistant", content: [{ type: "tool_use", id: "err123AbC", name: "add_session", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "err123AbC", is_error: true, content: "CONTEXT_UNSAFE: add_session is blocked." }] },
    ]);
    expect(out[2]).toEqual({ role: "tool", tool_call_id: "err123AbC", name: "add_session", content: "CONTEXT_UNSAFE: add_session is blocked." });
    // no trailing empty user turn when the feedback carried no text block
    expect(out).toHaveLength(3);
  });

  it("passes plain-string history turns through unchanged (critique rounds)", () => {
    const out = toMistralMessages(SYSTEM, [
      { role: "user", content: "context..." },
      { role: "assistant", content: "I shortened Saturday." },
      { role: "user", content: "make it even easier" },
    ]);
    expect(out.slice(1)).toEqual([
      { role: "user", content: "context..." },
      { role: "assistant", content: "I shortened Saturday." },
      { role: "user", content: "make it even easier" },
    ]);
  });
});

describe("fromMistralResponse", () => {
  it("maps text + tool_calls to Anthropic-shaped blocks with parsed input", () => {
    const resp = fromMistralResponse({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: "Let me adjust that.",
          tool_calls: [{ id: "xY1zQ9aB3", function: { name: "reduce_week_volume", arguments: '{"week_number":4,"factor":0.8}' } }],
        },
      }],
      usage: { prompt_tokens: 1200, completion_tokens: 90 },
    });
    expect(resp).toEqual({
      content: [
        { type: "text", text: "Let me adjust that." },
        { type: "tool_use", id: "xY1zQ9aB3", name: "reduce_week_volume", input: { week_number: 4, factor: 0.8 } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1200, output_tokens: 90 },
    });
  });

  it("handles chunked content arrays, already-object arguments, and plain stop", () => {
    const resp = fromMistralResponse({
      choices: [{
        finish_reason: "stop",
        message: {
          content: [{ type: "text", text: "All set — " }, { type: "text", text: "rest up." }],
          tool_calls: [{ id: "qQ2wE8rT0", function: { name: "shift_workout", arguments: { session_id: "s2", new_date: "2026-08-01" } } }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(resp.content[0]).toEqual({ type: "text", text: "All set — \nrest up." });
    expect(resp.content[1]).toMatchObject({ type: "tool_use", input: { session_id: "s2", new_date: "2026-08-01" } });
    expect(resp.stop_reason).toBe("end_turn");
  });

  it("degrades malformed tool arguments to {} instead of throwing (tool layer answers with a typed error)", () => {
    const resp = fromMistralResponse({
      choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "bad123XyZ", function: { name: "swap_session", arguments: "{not json" } }] } }],
    });
    expect(resp.content).toEqual([{ type: "tool_use", id: "bad123XyZ", name: "swap_session", input: {} }]);
    expect(resp.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe("makeMistralModel", () => {
  it("posts the converted request and returns the converted response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: "stop", message: { content: "Done." } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }),
    });
    const callModel = makeMistralModel({ apiKey: "k", model: "mistral-large-latest", systemPrompt: SYSTEM, fetchImpl });
    const out = await callModel(
      [{ role: "user", content: "hello" }],
      [{ name: "t", description: "d", input_schema: { type: "object", properties: {} } }],
    );
    expect(out).toEqual({ content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 3 } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer k");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("mistral-large-latest");
    expect(body.messages[0]).toEqual({ role: "system", content: SYSTEM });
    expect(body.tools[0].type).toBe("function");
    expect(body.tool_choice).toBe("auto");
  });

  it("retries retryable statuses then succeeds; gives up immediately on 4xx", async () => {
    vi.useFakeTimers();
    try {
      const ok = {
        ok: true,
        json: async () => ({ choices: [{ finish_reason: "stop", message: { content: "hi" } }], usage: {} }),
      };
      const overloaded = { ok: false, status: 503, text: async () => "overloaded" };
      const fetchImpl = vi.fn().mockResolvedValueOnce(overloaded).mockResolvedValueOnce(ok);
      const callModel = makeMistralModel({ apiKey: "k", model: "mistral-large-latest", systemPrompt: SYSTEM, fetchImpl });
      const pending = callModel([{ role: "user", content: "x" }], []);
      await vi.runAllTimersAsync();
      const out = await pending;
      expect(out.content[0]).toEqual({ type: "text", text: "hi" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      const badRequest = { ok: false, status: 400, text: async () => "bad request" };
      const failFast = makeMistralModel({ apiKey: "k", model: "mistral-large-latest", systemPrompt: SYSTEM, fetchImpl: vi.fn().mockResolvedValue(badRequest) });
      const failing = failFast([{ role: "user", content: "x" }], []);
      failing.catch(() => {}); // attach early so the rejection is never unhandled
      await vi.runAllTimersAsync();
      await expect(failing).rejects.toThrow("Mistral API 400");
    } finally {
      vi.useRealTimers();
    }
  });
});
