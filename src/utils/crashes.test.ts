import { describe, it, expect, vi } from "vitest";
// @ts-expect-error — plain ESM module shared with the edge functions and promote scripts.
import { buildCrashesSql, checkBuildCrashes, crashGateVerdict, crashMessage, formatCrashAlert, queryPostHog, recentCrashesSql } from "../../supabase/functions/_shared/crashes.mjs";

const ENV = { POSTHOG_PERSONAL_API_KEY: "phx_key", POSTHOG_PROJECT_ID: "209798" };

const respond = (body: unknown, status = 200) =>
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(body), { status }));

const crashRows = { columns: ["message", "events", "people"], results: [['["Boom"]', 4, 2]] };

describe("crashMessage", () => {
  it("reads the first message out of PostHog's JSON array", () => {
    expect(crashMessage('["\\"SignInWithApple.then()\\" is not implemented on ios"]'))
      .toBe('"SignInWithApple.then()" is not implemented on ios');
  });

  it("falls back to the raw text", () => {
    expect(crashMessage("plain")).toBe("plain");
    expect(crashMessage("")).toBe("(no message)");
  });
});

describe("crash queries", () => {
  it("matches one native build exactly, on one OS", () => {
    const sql = buildCrashesSql({ build: "1092001", os: "iOS" });
    expect(sql).toContain("' (1092001)'");
    expect(sql).toContain("properties.$os = 'iOS'");
    expect(sql).toContain("NOT IN ('preview', 'development')");
  });

  it("refuses anything that isn't a build number or a known OS", () => {
    expect(() => buildCrashesSql({ build: "1' OR 1=1 --", os: "iOS" })).toThrow(/build number/);
    expect(() => buildCrashesSql({ build: "1092001", os: "Windows" })).toThrow(/os must be/);
    expect(() => recentCrashesSql(0)).toThrow();
  });

  it("windows the digest query on the requested days", () => {
    expect(recentCrashesSql(7)).toContain("INTERVAL 7 DAY");
  });
});

describe("queryPostHog", () => {
  it("posts HogQL and keys rows by column", async () => {
    const fetchImpl = respond(crashRows);
    const rows = await queryPostHog({ apiKey: "k", projectId: "209798", sql: "SELECT 1" }, fetchImpl);
    expect(rows).toEqual([{ message: '["Boom"]', events: 4, people: 2 }]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://eu.posthog.com/api/projects/209798/query/");
    expect(JSON.parse(String(init.body)).query).toEqual({ kind: "HogQLQuery", query: "SELECT 1" });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  it("throws with the status on a failed query", async () => {
    await expect(queryPostHog({ apiKey: "k", projectId: "1", sql: "x" }, respond({ detail: "no" }, 403)))
      .rejects.toThrow(/403/);
  });
});

describe("formatCrashAlert", () => {
  it("names the crash and links back to PostHog", () => {
    const { subject, text } = formatCrashAlert({
      kind: "created",
      name: "Error",
      description: "SignInWithApple.then() is not implemented",
      url: "https://eu.posthog.com/project/209798/error-tracking/fingerprint/abc",
    });
    expect(subject).toBe("Running Coach - new crash: Error");
    expect(text).toContain("SignInWithApple.then() is not implemented");
    expect(text).toContain("Open in PostHog: https://eu.posthog.com/project/209798/error-tracking/fingerprint/abc");
  });

  it("drops a link that doesn't point at PostHog", () => {
    expect(formatCrashAlert({ name: "x", url: "https://evil.example/login" }).text).not.toContain("evil");
  });

  it("reports spike volume, and an unknown kind reads as a new crash", () => {
    expect(formatCrashAlert({ kind: "spiking", name: "x", events: "12", baseline: "1" }).text)
      .toContain("Reports in the last 5 minutes: 12 (baseline 1)");
    expect(formatCrashAlert({ kind: "bogus", name: "x" }).subject).toContain("new crash");
    expect(formatCrashAlert({ kind: "$error_tracking_issue_reopened", name: "x" }).subject).toContain("crash is back");
  });
});

describe("release crash gate", () => {
  it("blocks a build with crash reports unless told to ignore them", () => {
    const rows = [{ message: '["Boom"]', events: 4, people: 2 }];
    expect(crashGateVerdict(rows, { buildLabel: "1.21.10 (1092001)", ignore: false }).ok).toBe(false);
    expect(crashGateVerdict(rows, { buildLabel: "1.21.10 (1092001)", ignore: true }).ok).toBe(true);
    expect(crashGateVerdict([], { buildLabel: "1.21.10 (1092001)", ignore: false }).ok).toBe(true);
  });

  it("throws on crashes, and only warns when PostHog is unset or unreachable", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const target = { build: "1092001", os: "iOS", buildLabel: "1.21.10 (1092001)" };
    await expect(checkBuildCrashes(ENV, target, respond(crashRows))).rejects.toThrow(/not promoting/);
    await expect(checkBuildCrashes({ ...ENV, IGNORE_CRASHES: "true" }, target, respond(crashRows))).resolves.toBeUndefined();
    await expect(checkBuildCrashes({}, target, respond(crashRows))).resolves.toBeUndefined();
    await expect(checkBuildCrashes(ENV, target, respond({}, 500))).resolves.toBeUndefined();
    expect(log.mock.calls.flat().join("\n")).toContain("::warning::Crash check skipped");
    log.mockRestore();
  });
});
