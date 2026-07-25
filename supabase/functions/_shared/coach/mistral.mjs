// Mistral provider adapter for the coach agent. The engine
// (engine.mjs generateProposal) speaks the Anthropic Messages shape end to
// end: callModel(messages, tools) → { content: [text|tool_use blocks],
// stop_reason, usage: { input_tokens, output_tokens } }, with tool_result
// blocks round-tripped inside user turns. This module translates that
// contract to Mistral's chat-completions API so the engine, tools, validator
// and mock never learn a second wire format. Provider choice is by model
// name: isMistralModel(COACH_MODEL) routes here, anything else stays on the
// Anthropic client — so COACH_MODEL=claude-sonnet-5 remains the instant
// rollback lever.
//
// Plain ESM + fetch, no SDK: imported by the Deno edge function, the Vitest
// unit tests, and the live eval harness alike.
//
// Contract notes (kept deliberately narrow):
//  * Mistral generates the tool-call ids (9-char alphanumerics); we pass them
//    through unchanged, so the engine's tool_use.id ↔ tool_result.tool_use_id
//    round-trip is Mistral-native and never needs re-mapping.
//  * A tool_result's is_error flag has no Mistral equivalent; the content
//    already carries the `CODE: message` text the engine builds, which is
//    what the model actually steers on.
//  * Mistral has no cache_control; the system prompt is sent as a plain
//    system message (no prompt-caching discount on this provider).

export const isMistralModel = (model) =>
  /^(mistral|magistral|ministral|codestral|pixtral|open-mistral|open-mixtral)/i.test(String(model ?? ""));

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

// Anthropic tool def {name, description, input_schema} → Mistral/OpenAI
// {type:"function", function:{name, description, parameters}}.
export const toMistralTools = (tools) =>
  (tools ?? []).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

const textOfBlocks = (blocks) =>
  blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");

// Engine messages (Anthropic shape) → Mistral messages. The engine produces
// exactly these turn shapes:
//   user/assistant with string content            → passthrough
//   assistant with blocks (echoed model response) → text + tool_calls
//   user with blocks ([tool_result..., text?])    → role:"tool" per result,
//                                                   then one user turn for text
// Tool messages must immediately follow the assistant turn that issued the
// calls — the engine's push order already guarantees that.
export function toMistralMessages(systemPrompt, messages) {
  const out = [{ role: "system", content: systemPrompt }];
  // tool_call id → function name (Mistral's tool message carries `name`).
  const nameById = new Map();
  for (const m of messages) {
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === "tool_use") nameById.set(b.id, b.name);
    }
  }
  for (const m of messages) {
    if (!Array.isArray(m.content)) {
      out.push({ role: m.role, content: String(m.content ?? "") });
      continue;
    }
    if (m.role === "assistant") {
      const toolCalls = m.content.filter((b) => b.type === "tool_use").map((b) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      const msg = { role: "assistant", content: textOfBlocks(m.content) };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }
    // user turn with blocks: tool results first (engine order), then any text.
    for (const b of m.content) {
      if (b.type !== "tool_result") continue;
      out.push({
        role: "tool",
        tool_call_id: b.tool_use_id,
        name: nameById.get(b.tool_use_id) ?? "unknown_tool",
        content: typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""),
      });
    }
    const text = textOfBlocks(m.content);
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

const STOP_REASON = { tool_calls: "tool_use", stop: "end_turn", length: "max_tokens" };

// Tool-call arguments arrive as a JSON string (occasionally already an
// object). A malformed string degrades to {} — the tool layer then answers
// with a typed CoachToolError the model can correct from, which beats
// throwing the whole round away.
const parseArgs = (args) => {
  if (args && typeof args === "object") return args;
  try {
    const parsed = JSON.parse(String(args ?? "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

// Mistral chat completion → Anthropic-shaped Message for the engine.
export function fromMistralResponse(data) {
  const choice = data?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  // content may be a string or an array of {type:"text", text} chunks.
  const text = Array.isArray(msg.content) ? textOfBlocks(msg.content) : String(msg.content ?? "");
  if (text.trim()) content.push({ type: "text", text });
  for (const tc of msg.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function?.name,
      input: parseArgs(tc.function?.arguments),
    });
  }
  return {
    content,
    stop_reason: STOP_REASON[choice.finish_reason] ?? choice.finish_reason ?? "end_turn",
    usage: {
      input_tokens: data?.usage?.prompt_tokens ?? 0,
      output_tokens: data?.usage?.completion_tokens ?? 0,
    },
  };
}

// callModel factory with the same signature the engine expects from the
// Anthropic path. Retries transient failures with exponential backoff
// (mirrors the eval harness's anthropic.mjs and the SDK's maxRetries), and
// bounds each attempt with timeoutMs so one hung call can't stall a round.
export function makeMistralModel({
  apiKey,
  model,
  systemPrompt,
  maxRetries = 3,
  timeoutMs = 60000,
  baseUrl = "https://api.mistral.ai",
  fetchImpl = fetch,
}) {
  return async (messages, tools) => {
    const body = JSON.stringify({
      model,
      max_tokens: 4096,
      messages: toMistralMessages(systemPrompt, messages),
      tools: toMistralTools(tools),
      tool_choice: "auto",
    });
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // Network/timeout: retryable up to the budget.
        if (attempt >= maxRetries) throw err;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (res.ok) return fromMistralResponse(await res.json());
      const detail = await res.text().catch(() => "");
      if (!RETRYABLE.has(res.status) || attempt >= maxRetries) {
        throw new Error(`Mistral API ${res.status}: ${detail.slice(0, 300)}`);
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  };
}
