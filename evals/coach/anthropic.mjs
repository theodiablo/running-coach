// Minimal live callModel for the eval harness — plain fetch against the
// Messages API, mirroring the edge function's request shape (same system
// block + cache_control breakpoint) so the eval exercises what production
// sends. No SDK dependency; retries transient failures with backoff.

export function makeLiveModel({ apiKey, model, systemPrompt, baseUrl = "https://api.anthropic.com" }) {
  return async (messages, tools) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2026-10-21",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
          tools,
          messages,
        }),
      });
      if (res.ok) return await res.json();
      const body = await res.text().catch(() => "");
      const retryable = [408, 429, 500, 502, 503, 529].includes(res.status);
      if (!retryable || attempt >= 3) throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
      await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
    }
  };
}
