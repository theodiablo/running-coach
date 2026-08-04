// notify-contribution — best-effort email (AWS SES via aws4fetch) after a race
// contribution, report, or coach-feedback flag is written. Never on the
// critical path; a no-op without SES credentials. Details: docs/races.md.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";
import { CORS, json } from "../_shared/cors.mjs";

const MAINTAINER_EMAIL = Deno.env.get("MAINTAINER_EMAIL") ?? "theo.camboulive.dev@gmail.com";
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") ?? "Running Coach <noreply@camboulive.solutions>";
const SES_REGION = Deno.env.get("SES_REGION") ?? "eu-west-1";
const CONFIG_SET = Deno.env.get("SES_CONFIG_SET") ?? "runapp-notify";

const SES_ACCESS_KEY_ID = Deno.env.get("SES_AWS_ACCESS_KEY_ID");
const SES_SECRET_ACCESS_KEY = Deno.env.get("SES_AWS_SECRET_ACCESS_KEY");
const hasSesCreds = Boolean(SES_ACCESS_KEY_ID && SES_SECRET_ACCESS_KEY);

const aws = hasSesCreds
  ? new AwsClient({
      accessKeyId: SES_ACCESS_KEY_ID!,
      secretAccessKey: SES_SECRET_ACCESS_KEY!,
      region: SES_REGION,
      service: "ses",
    })
  : null;

const asString = (value: unknown) => (typeof value === "string" ? value.trim() : "");

type DbClient = ReturnType<typeof createClient<any>>;

const notificationLimitExceeded = async (admin: DbClient, userId: string) => {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error } = await admin
    .from("contribution_notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since);
  if (error) throw error;
  return (count ?? 0) >= 20;
};

const reserveNotification = async (admin: DbClient, kind: string, reference: string, userId: string) => {
  const { error } = await admin
    .from("contribution_notifications")
    .insert({ kind, reference, user_id: userId });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw error;
};

async function raceName(admin: DbClient, raceSlug: string) {
  const { data } = await admin.from("races").select("name").eq("slug", raceSlug).maybeSingle();
  return data?.name ?? raceSlug;
}

async function notificationContext(admin: DbClient, userId: string, payload: Record<string, unknown>) {
  const kind = asString(payload.type);
  if (kind === "race") {
    const raceSlug = asString(payload.raceSlug);
    if (!raceSlug) return null;
    const { data } = await admin.from("races")
      .select("slug, name, city, country, url, distances, created_at")
      .eq("slug", raceSlug)
      .eq("created_by", userId)
      .maybeSingle();
    if (!data) return null;
    const editionId = asString(payload.editionId);
    const { data: edition } = editionId
      ? await admin.from("race_editions")
        .select("id, date, distance_km, elevation")
        .eq("id", editionId)
        .eq("race_slug", data.slug)
        .eq("created_by", userId)
        .maybeSingle()
      : { data: null };
    const editionText = edition
      ? `\nFirst edition: ${edition.id}\nDate: ${edition.date}\nDistance km: ${edition.distance_km}\nElevation m: ${edition.elevation}`
      : "";
    return {
      kind,
      reference: data.slug,
      maintainerSubject: "Running Coach - new race",
      maintainerText: `A user submitted a race.\n\nContributor row owner: ${userId}\n\nRace: ${data.name}\nSlug: ${data.slug}\nCity: ${data.city ?? ""}\nCountry: ${data.country ?? ""}\nDistances: ${JSON.stringify(data.distances ?? [])}${editionText}\nURL: ${data.url ?? ""}\nCreated: ${data.created_at}\n\nReview in the Supabase dashboard (races / race_editions).`,
      thanksName: data.name,
    };
  }

  if (kind === "edition") {
    const editionId = asString(payload.editionId);
    if (!editionId) return null;
    const { data } = await admin.from("race_editions")
      .select("id, race_slug, date, distance_km, elevation, created_at")
      .eq("id", editionId)
      .eq("created_by", userId)
      .maybeSingle();
    if (!data) return null;
    const name = await raceName(admin, data.race_slug);
    return {
      kind,
      reference: data.id,
      maintainerSubject: "Running Coach - new race edition",
      maintainerText: `A user submitted a race edition.\n\nContributor row owner: ${userId}\n\nRace: ${name}\nRace slug: ${data.race_slug}\nEdition: ${data.id}\nDate: ${data.date}\nDistance km: ${data.distance_km}\nElevation m: ${data.elevation}\nCreated: ${data.created_at}\n\nReview in the Supabase dashboard (race_editions).`,
      thanksName: name,
    };
  }

  if (kind === "report") {
    const reportId = asString(payload.reportId);
    if (!reportId) return null;
    const { data } = await admin.from("race_reports")
      .select("id, race_slug, edition_id, reason, note, created_at")
      .eq("id", reportId)
      .eq("reporter_id", userId)
      .maybeSingle();
    if (!data) return null;
    return {
      kind,
      reference: data.id,
      maintainerSubject: "Running Coach - race report",
      maintainerText: `A user reported a race.\n\nReporter row owner: ${userId}\n\nReport: ${data.id}\nRace slug: ${data.race_slug ?? ""}\nEdition: ${data.edition_id ?? ""}\nReason: ${data.reason}\nNote: ${data.note ?? ""}\nCreated: ${data.created_at}\n\nReview in the Supabase dashboard (race_reports).`,
      thanksName: null,
    };
  }

  if (kind === "coach_feedback") {
    const feedbackId = asString(payload.feedbackId);
    if (!feedbackId) return null;
    const { data } = await admin.from("coach_feedback")
      .select("id, trajectory_id, round_index, correction, created_at")
      .eq("id", feedbackId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return null;
    return {
      kind,
      reference: data.id,
      maintainerSubject: "Running Coach - coach feedback",
      maintainerText: `A user flagged an AI coach answer as wrong.\n\nFeedback row owner: ${userId}\n\nFeedback: ${data.id}\nTrajectory: ${data.trajectory_id}\nRound: ${data.round_index}\nCorrection: ${data.correction}\nCreated: ${data.created_at}\n\nReview alongside the full round context (rationale, tool_calls, input_context) via the join query in docs/coach-agent.md, run against coach_feedback / agent_rounds in the Supabase SQL editor.`,
      thanksName: null,
    };
  }

  return null;
}

async function sendEmail(to: string, subject: string, text: string) {
  if (!aws) return false;
  const res = await aws.fetch(
    `https://email.${SES_REGION}.amazonaws.com/v2/email/outbound-emails`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        FromEmailAddress: FROM_EMAIL,
        Destination: { ToAddresses: [to] },
        ConfigurationSetName: CONFIG_SET,
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: { Text: { Data: text, Charset: "UTF-8" } },
          },
        },
      }),
    },
  );
  if (!res.ok) console.error("ses failed", res.status, await res.text());
  return res.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const payload = await req.json().catch(() => ({})) as Record<string, unknown>;

    // Resolve the contributor's email from their JWT (don't trust the body).
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "unauthorized" }, 401);
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: auth } = await userClient.auth.getUser();
    const user = auth?.user;
    if (!user) return json({ error: "unauthorized" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const context = await notificationContext(admin, user.id, payload);
    if (!context) return json({ error: "notification source row not found" }, 404);

    if (!hasSesCreds) return json({ skipped: "no SES credentials configured" });
    if (await notificationLimitExceeded(admin, user.id)) return json({ skipped: "notification rate limit exceeded" });
    if (!(await reserveNotification(admin, context.kind, context.reference, user.id))) {
      return json({ skipped: "already notified" });
    }

    // 1) Maintainer notice. The email body is built from validated DB rows, not
    // from arbitrary caller-controlled notification payloads.
    await sendEmail(
      MAINTAINER_EMAIL,
      context.maintainerSubject,
      `Contributor: ${user.email ?? "unknown"}\n\n${context.maintainerText}`,
    );

    // 2) Thank-you to the contributor (reports and coach feedback are
    // anonymous-ish / already acknowledged in-app; skip the email there).
    if (user.email && context.thanksName) {
      await sendEmail(
        user.email,
        "Thanks for adding a race to Running Coach",
        `Thanks for contributing "${context.thanksName}" to the shared race catalogue!\n\nIt's live for everyone right now, tagged as unverified. We'll review it and let you know once it's verified.\n\n- Running Coach`,
      );
    }

    return json({ ok: true });
  } catch (err) {
    console.error("notify-contribution error", err);
    return json({ error: String(err) }, 200); // never fail the caller
  }
});
