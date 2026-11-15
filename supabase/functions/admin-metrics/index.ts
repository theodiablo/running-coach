// admin-metrics: aggregate product metrics for the maintainer. Two doors, both checked here (no gateway-verifiable
// JWT for the digest): the weekly workflow POSTs `x-admin-digest-secret` and gets the digest emailed; a signed-in
// ADMIN_USER_ID session at aal2 (MFA) gets the JSON. Everyone else gets 403. docs/product-metrics.md.

import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { estimateCost, formatDigest, isAdminCaller, safeEqual } from "../_shared/adminMetrics.mjs";
import { queryPostHog, recentCrashesSql } from "../_shared/crashes.mjs";
import { canSendEmail, emailMaintainer } from "../_shared/sesEmail.ts";

const DIGEST_SECRET = Deno.env.get("ADMIN_DIGEST_SECRET") ?? "";
const ADMIN_USER_ID = Deno.env.get("ADMIN_USER_ID") ?? "";
const POSTHOG_PERSONAL_API_KEY = Deno.env.get("POSTHOG_PERSONAL_API_KEY") ?? "";
const POSTHOG_PROJECT_ID = Deno.env.get("POSTHOG_PROJECT_ID") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const admin = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function loadMetrics() {
  const { data, error } = await admin().rpc("admin_metrics");
  if (error) throw error;
  return data;
}

// null = PostHog not configured (the digest omits the section); an Error = say it failed.
async function loadCrashes() {
  if (!POSTHOG_PERSONAL_API_KEY || !POSTHOG_PROJECT_ID) return null;
  try {
    return await queryPostHog({ apiKey: POSTHOG_PERSONAL_API_KEY, projectId: POSTHOG_PROJECT_ID, sql: recentCrashesSql(7) });
  } catch (err) {
    console.error("crash query failed", err);
    return err instanceof Error ? err : new Error(String(err));
  }
}

async function digest(req: Request) {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!DIGEST_SECRET || !safeEqual(req.headers.get("x-admin-digest-secret"), DIGEST_SECRET)) {
    return json({ error: "forbidden" }, 403);
  }
  const [metrics, crashes] = await Promise.all([loadMetrics(), loadCrashes()]);
  const { subject, text } = formatDigest(metrics, { crashes });
  if (!canSendEmail()) return json({ error: "no SES credentials configured" }, 503);
  return (await emailMaintainer(subject, text)) ? json({ ok: true }) : json({ error: "send failed" }, 502);
}

async function dashboard(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!ADMIN_USER_ID || !jwt) return json({ error: "forbidden" }, 403);
  const { data } = await admin().auth.getUser(jwt);
  if (!isAdminCaller({ userId: data?.user?.id, jwt }, ADMIN_USER_ID)) return json({ error: "forbidden" }, 403);

  const metrics = await loadMetrics();
  const tokens = metrics.coach?.tokens ?? {};
  const cost = Object.fromEntries(Object.entries(tokens).map(([w, byModel]) => [w, estimateCost(byModel)]));
  return json({ ...metrics, coach: { ...metrics.coach, cost } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    return req.headers.has("x-admin-digest-secret") ? await digest(req) : await dashboard(req);
  } catch (err) {
    console.error("admin-metrics error", err);
    return json({ error: "internal error" }, 500);
  }
});
