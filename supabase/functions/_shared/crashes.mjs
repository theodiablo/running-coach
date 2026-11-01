// Crash reports, pure half: the PostHog queries over opt-in `$exception` events,
// and the text of the crash alert, the digest section and the release gate.
// Plain ESM for Deno, Node scripts and Vitest (src/utils/crashes.test.ts).
// Opt-in reports undercount: zero crashes is not proof of none. docs/telemetry.md.

export const POSTHOG_API_HOST = "https://eu.posthog.com";

const BUILD_RE = /^\d{1,12}$/;
const KINDS = { created: "New crash", reopened: "Crash is back", spiking: "Crash spiking" };

// `$exception_values` arrives as a JSON array of strings; the first is the message.
export function crashMessage(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return String(parsed[0]);
  } catch { /* not JSON: use as is */ }
  return String(raw ?? "").trim() || "(no message)";
}

const NOT_DEV = "ifNull(properties.environment, '') NOT IN ('preview', 'development')";
const APP_VERSION = "extract(toString(properties.trace), 'App: ([0-9.]+)')";

// Crash types seen in the last `days`, each with its first sighting over a 90-day lookback.
export function recentCrashesSql(days = 7) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 90) throw new Error(`days must be 1-90, got ${days}`);
  const inWindow = `timestamp >= now() - INTERVAL ${n} DAY`;
  return `SELECT
  toString(properties.$exception_values) AS message,
  countIf(${inWindow}) AS events,
  uniqIf(person_id, ${inWindow}) AS people,
  groupUniqArrayIf(${APP_VERSION}, ${inWindow}) AS versions,
  min(timestamp) >= now() - INTERVAL ${n} DAY AS is_new
FROM events
WHERE event = '$exception' AND timestamp >= now() - INTERVAL 90 DAY AND ${NOT_DEV}
GROUP BY message
HAVING events > 0
ORDER BY events DESC
LIMIT 20`;
}

// Crashes reported by one native build ("App: x.y.z (<build>)") on one OS.
export function buildCrashesSql({ build, os }) {
  const b = String(build ?? "").trim();
  if (!BUILD_RE.test(b)) throw new Error(`Not a build number: '${build}'`);
  if (os !== "iOS" && os !== "Android") throw new Error(`os must be iOS or Android, got '${os}'`);
  return `SELECT
  toString(properties.$exception_values) AS message,
  count() AS events,
  uniq(person_id) AS people
FROM events
WHERE event = '$exception' AND timestamp >= now() - INTERVAL 30 DAY AND ${NOT_DEV}
  AND properties.$os = '${os}'
  AND position(toString(properties.trace), ' (${b})') > 0
GROUP BY message
ORDER BY events DESC
LIMIT 20`;
}

// Runs HogQL through PostHog's query API and returns rows as objects keyed by column.
export async function queryPostHog({ apiKey, projectId, host = POSTHOG_API_HOST, sql }, fetchImpl = fetch) {
  const res = await fetchImpl(`${host}/api/projects/${encodeURIComponent(projectId)}/query/`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query: sql }, name: "running-coach crash check" }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PostHog query failed (${res.status}): ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  const cols = body.columns ?? [];
  return (body.results ?? []).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

const versionsLabel = (vs) => {
  const list = (vs ?? []).map((v) => v || "web").filter((v, i, a) => a.indexOf(v) === i);
  return list.length ? list.join(", ") : "web";
};

// The digest's crash section: null rows = not configured (omit), an Error = say it failed.
export function formatCrashSection(rows) {
  if (rows == null) return [];
  if (rows instanceof Error) return ["", "Crashes (opt-in reports)", "  Couldn't read PostHog this week."];
  if (!rows.length) return ["", "Crashes (opt-in reports)", "  None reported this week."];
  return [
    "",
    "Crashes (opt-in reports)",
    ...rows.map((r) =>
      `  ${r.is_new ? "NEW " : ""}${crashMessage(r.message).slice(0, 120)}\n    ${r.events} reports from ${r.people} people; builds ${versionsLabel(r.versions)}`,
    ),
  ];
}

const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// Email for one PostHog error-tracking alert. Only links back to PostHog itself.
export function formatCrashAlert(body) {
  const kind = KINDS[body?.kind] ? body.kind : "created";
  const name = clip(body?.name, 150) || "(unnamed crash)";
  const description = clip(body?.description, 1000);
  const url = String(body?.url ?? "");
  const link = url.startsWith(`${POSTHOG_API_HOST}/`) ? url : "";
  const lines = [`${KINDS[kind]}: ${name}`, ""];
  if (description) lines.push(description, "");
  if (kind === "spiking" && body?.events) {
    lines.push(`Reports in the last 5 minutes: ${clip(body.events, 12)} (baseline ${clip(body.baseline, 12) || "none yet"})`, "");
  }
  if (link) lines.push(`Open in PostHog: ${link}`, "");
  lines.push("Crash reports are opt-in, so this is a sample of what users hit, not a count.");
  return { subject: `Running Coach - ${KINDS[kind].toLowerCase()}: ${clip(name, 80)}`, text: lines.join("\n") + "\n" };
}

// Release gate result: what to print, and whether promotion may go ahead.
export function crashGateVerdict(rows, { buildLabel, ignore }) {
  if (!rows.length) {
    return { ok: true, lines: [`No crash reports from build ${buildLabel} (reports are opt-in, so this is not proof).`] };
  }
  const lines = [
    `Build ${buildLabel} has crash reports in the last 30 days:`,
    ...rows.map((r) => `  ${r.events}x (${r.people} people): ${crashMessage(r.message).slice(0, 200)}`),
  ];
  if (ignore) return { ok: true, lines: [...lines, "Promoting anyway: ignore_crashes is set."] };
  return { ok: false, lines: [...lines, "Not promoting. Fix them, or re-run with ignore_crashes if they are known and harmless."] };
}

// Shared by both promote scripts. Never blocks on PostHog being unreachable or unset.
export async function checkBuildCrashes(env, { build, os, buildLabel }, fetchImpl = fetch) {
  const apiKey = env.POSTHOG_PERSONAL_API_KEY?.trim();
  const projectId = env.POSTHOG_PROJECT_ID?.trim();
  if (!apiKey || !projectId) {
    console.log("::warning::POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID not set: skipping the crash check.");
    return;
  }
  let rows;
  try {
    rows = await queryPostHog({ apiKey, projectId, sql: buildCrashesSql({ build, os }) }, fetchImpl);
  } catch (err) {
    console.log(`::warning::Crash check skipped: ${err.message}`);
    return;
  }
  const verdict = crashGateVerdict(rows, { buildLabel, ignore: env.IGNORE_CRASHES === "true" });
  for (const line of verdict.lines) console.log(line);
  if (!verdict.ok) throw new Error(`Build ${buildLabel} has crash reports; not promoting.`);
}
