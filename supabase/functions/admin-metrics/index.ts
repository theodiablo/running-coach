// admin-metrics — product metrics for the maintainer, aggregates only. Two
// doors, both checked here because neither carries a gateway-verifiable JWT
// for the digest: the weekly workflow POSTs with `x-admin-digest-secret` and
// gets the digest emailed; a signed-in ADMIN_USER_ID session at aal2 (MFA)
// gets the JSON. Everyone else gets 403. docs/product-metrics.md.

import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { AwsClient } from "npm:aws4fetch@1.0.20";
import { estimateCost, formatDigest, isAdminCaller, safeEqual } from "../_shared/adminMetrics.mjs";

const DIGEST_SECRET = Deno.env.get("ADMIN_DIGEST_SECRET") ?? "";
const ADMIN_USER_ID = Deno.env.get("ADMIN_USER_ID") ?? "";
const MAINTAINER_EMAIL = Deno.env.get("MAINTAINER_EMAIL") ?? "theo.camboulive.dev@gmail.com";
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") ?? "Running Coach <noreply@camboulive.solutions>";
const SES_REGION = Deno.env.get("SES_REGION") ?? "eu-west-1";
const CONFIG_SET = Deno.env.get("SES_CONFIG_SET") ?? "runapp-notify";

const SES_ACCESS_KEY_ID = Deno.env.get("SES_AWS_ACCESS_KEY_ID");
const SES_SECRET_ACCESS_KEY = Deno.env.get("SES_AWS_SECRET_ACCESS_KEY");
const aws = SES_ACCESS_KEY_ID && SES_SECRET_ACCESS_KEY
  ? new AwsClient({
      accessKeyId: SES_ACCESS_KEY_ID,
      secretAccessKey: SES_SECRET_ACCESS_KEY,
      region: SES_REGION,
      service: "ses",
    })
  : null;

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

async function sendEmail(subject: string, text: string) {
  const res = await aws!.fetch(`https://email.${SES_REGION}.amazonaws.com/v2/email/outbound-emails`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      FromEmailAddress: FROM_EMAIL,
      Destination: { ToAddresses: [MAINTAINER_EMAIL] },
      ConfigurationSetName: CONFIG_SET,
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: { Text: { Data: text, Charset: "UTF-8" } },
        },
      },
    }),
  });
  if (!res.ok) console.error("ses failed", res.status, await res.text());
  return res.ok;
}

async function digest(req: Request) {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!DIGEST_SECRET || !safeEqual(req.headers.get("x-admin-digest-secret"), DIGEST_SECRET)) {
    return json({ error: "forbidden" }, 403);
  }
  const { subject, text } = formatDigest(await loadMetrics());
  if (!aws) return json({ error: "no SES credentials configured" }, 503);
  return (await sendEmail(subject, text)) ? json({ ok: true }) : json({ error: "send failed" }, 502);
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
