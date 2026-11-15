// crash-alert: PostHog's error-tracking alerts POST here (new, reopened or spiking crash),
// and the maintainer gets an email. The only door is the shared secret header. docs/telemetry.md.

import { safeEqual } from "../_shared/adminMetrics.mjs";
import { formatCrashAlert } from "../_shared/crashes.mjs";
import { canSendEmail, emailMaintainer } from "../_shared/sesEmail.ts";

const SECRET = Deno.env.get("CRASH_ALERT_SECRET") ?? "";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!SECRET || !safeEqual(req.headers.get("x-crash-alert-secret"), SECRET)) return json({ error: "forbidden" }, 403);
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "bad request" }, 400);
    if (!canSendEmail()) return json({ error: "no SES credentials configured" }, 503);
    const { subject, text } = formatCrashAlert(body);
    return (await emailMaintainer(subject, text)) ? json({ ok: true }) : json({ error: "send failed" }, 502);
  } catch (err) {
    console.error("crash-alert error", err);
    return json({ error: "internal error" }, 500);
  }
});
