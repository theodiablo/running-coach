import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Credentials that live in a main-only GitHub Environment, never in repo secrets
// (docs/release.md, "Supabase access tokens"; infra/README.md, "OIDC trust").
const ENVIRONMENT_SECRETS: Record<string, string> = {
  SUPABASE_FUNCTIONS_TOKEN: "supabase-functions",
  SUPABASE_APP_CONFIG_TOKEN: "supabase-app-config",
  SUPABASE_DB_URL: "backup",
};

// Code a compromised dependency could hijack: install scripts, package bins.
const THIRD_PARTY_CODE = [/\bnpm (ci|install|i)\b(?!.*--ignore-scripts)/, /\bnpx\b/, /\bnpm run\b/, /\bpod install\b/, /gradlew/];

const DIR = join(__dirname, "..", ".github", "workflows");
const workflows = readdirSync(DIR)
  .filter((f) => f.endsWith(".yml"))
  .map((file) => ({
    file,
    // Comments explain the setup and may name anything; only live lines count.
    text: readFileSync(join(DIR, file), "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n"),
  }));

const jobsOf = (text: string) => {
  const body = text.split(/^jobs:\s*$/m)[1] ?? "";
  return body
    .split(/^(?= {2}[\w-]+:\s*$)/m)
    .filter((b) => /^ {2}[\w-]+:/.test(b))
    .map((b) => ({ name: b.match(/^ {2}([\w-]+):/)![1], text: b }));
};

const prTriggered = (text: string) => /^\s*(pull_request|pull_request_target)\s*:?/m.test(text.split(/^jobs:/m)[0]);

describe("workflow credentials", () => {
  it("no workflow reads the old account-wide SUPABASE_ACCESS_TOKEN repo secret", () => {
    const hits = workflows.filter((w) => /secrets\.SUPABASE_ACCESS_TOKEN\b/.test(w.text)).map((w) => w.file);
    expect(hits).toEqual([]);
  });

  const uses = workflows.flatMap((w) =>
    jobsOf(w.text).flatMap((job) =>
      Object.entries(ENVIRONMENT_SECRETS)
        .filter(([secret]) => new RegExp(`secrets\\.${secret}\\b`).test(job.text))
        .map(([secret, env]) => ({ where: `${w.file} › ${job.name}`, workflow: w, job, secret, env })),
    ),
  );

  it("finds the jobs it guards", () => {
    expect(uses.map((u) => u.where).sort()).toEqual([
      "db-backup.yml › backup",
      "deploy-supabase-functions.yml › deploy",
      "publish-version.yml › publish",
      "release.yml › stage-android",
      "release.yml › stage-ios",
    ]);
  });

  it.each(uses)("$where reads $secret only inside the $env environment", ({ job, env }) => {
    expect(job.text).toMatch(new RegExp(`^ {4}environment: ${env}\\s*$`, "m"));
  });

  it.each(uses)("$where runs no dependency code next to $secret", ({ job }) => {
    expect(THIRD_PARTY_CODE.filter((re) => re.test(job.text)).map(String)).toEqual([]);
  });

  it.each(uses)("$where is not in a pull_request-triggered workflow", ({ workflow }) => {
    expect(prTriggered(workflow.text)).toBe(false);
  });
});
