// suunto-webhook — public endpoint Suunto notifies when a user syncs a new
// workout. No user JWT (verify_jwt = false in supabase/config.toml): the caller
// is Suunto's cloud, authenticated by the HMAC-SHA256 signature over the RAW
// request body. All it does is map the Suunto username to app user(s) and stage
// the workoutKey — the heavy lifting (FIT download) happens in suunto-import's
// sync, so this always answers within Suunto's 2-second budget. Never returns
// non-2xx for content problems: 4xx/5xx feed Suunto's retry + circuit breaker,
// which would silently pause ALL notifications. Docs: docs/integrations-suunto.md.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const WEBHOOK_SECRET = Deno.env.get("SUUNTO_WEBHOOK_SECRET");

const ok = (body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

// Only what suunto-import's sync actually reads — the raw notification may
// carry more, but staged rows should stay small and predictable.
const PAYLOAD_KEYS = [
  "workoutKey", "activityId", "startTime", "totalTime", "totalDistance",
  "timeOffsetInMinutes", "avgHeartRate", "maxHeartRate", "hrdata",
] as const;

// Decode the X-HMAC-SHA256-Signature header (hex or base64 — CALIBRATE against
// the partner docs' example once credentials land). Null = undecodable garbage.
function decodeSignature(sig: string): Uint8Array | null {
  try {
    if (/^[0-9a-f]{64}$/i.test(sig)) {
      const out = new Uint8Array(32);
      for (let i = 0; i < 32; i++) out[i] = parseInt(sig.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    const bin = atob(sig);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

async function verifySignature(raw: ArrayBuffer, sig: string): Promise<boolean> {
  const sigBytes = decodeSignature(sig);
  if (!sigBytes || !WEBHOOK_SECRET) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  // Constant-time comparison happens inside subtle.verify.
  return await crypto.subtle.verify("HMAC", key, sigBytes as unknown as ArrayBuffer, raw);
}

// The body is JSON; legacy Suunto notifications may be form-encoded — tolerate both.
function parseBody(raw: ArrayBuffer, contentType: string): Record<string, unknown> | null {
  try {
    const text = new TextDecoder().decode(raw);
    if (contentType.includes("form-urlencoded")) {
      return Object.fromEntries(new URLSearchParams(text).entries());
    }
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  try {
    // Dormant until the secret is configured: with verify_jwt off, anything
    // other than an immediate 200 here would be an unauthenticated code path.
    if (!WEBHOOK_SECRET) return ok({ skipped: "not configured" });
    if (req.method !== "POST") return ok({ ignored: true });

    const raw = await req.arrayBuffer(); // HMAC is over the raw bytes, decode later
    const sig = req.headers.get("X-HMAC-SHA256-Signature") || "";
    if (!sig || !(await verifySignature(raw, sig))) {
      return new Response("forbidden", { status: 403 });
    }

    const body = parseBody(raw, req.headers.get("Content-Type") || "");
    const username = typeof body?.username === "string" ? body.username : "";
    const workoutKey = body?.workoutKey != null ? String(body.workoutKey) : "";
    // Malformed-but-signed → 200: retrying won't fix the shape.
    if (!username || !workoutKey) return ok({ ignored: true });

    const payload: Record<string, unknown> = {};
    for (const k of PAYLOAD_KEYS) if (body![k] !== undefined) payload[k] = body![k];

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    // One Suunto account may be connected by several app users — stage for each.
    // Unknown username → same 200 (no account-existence oracle, no retry storm).
    const { data: rows } = await admin.from("integration_connections")
      .select("user_id").eq("provider", "suunto").eq("external_user_id", username);
    const users = (rows || []) as { user_id: string }[];
    if (users.length) {
      await admin.from("integration_staged_workouts").upsert(
        users.map(u => ({ user_id: u.user_id, provider: "suunto", external_key: workoutKey, payload })),
      );
    }
    return ok();
  } catch (err) {
    // Never log bodies or signatures — a captured signed body is a replay credential.
    console.error("suunto-webhook error", err instanceof Error ? err.message : String(err));
    return ok({ error: "internal" }); // still 2xx: don't trip Suunto's circuit breaker
  }
});
