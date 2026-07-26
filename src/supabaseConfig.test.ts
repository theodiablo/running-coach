import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the `content_path` entries in `supabase/config.toml`.
 *
 * The CLI resolves them from two different bases: `[auth.email.template.*]`
 * from the directory the command runs in (the repo root), but
 * `[auth.email.notification.*]` from the config file's own directory. A path
 * that looks right by analogy with its neighbour is therefore wrong, and
 * nothing catches it until a command loads the config — which on 2026-07-26
 * meant the release workflow's version-staging step, after both stores had
 * already been published.
 */

const ROOT = process.cwd();
const CONFIG = join(ROOT, "supabase", "config.toml");
const SECTION = /^\s*\[([^\]]+)\]/;
const CONTENT_PATH = /^\s*content_path\s*=\s*"([^"]+)"/;

const entries: { section: string; path: string }[] = [];
let section = "";
for (const line of readFileSync(CONFIG, "utf8").split("\n")) {
  if (line.trimStart().startsWith("#")) continue;
  const header = SECTION.exec(line);
  if (header) {
    section = header[1];
    continue;
  }
  const match = CONTENT_PATH.exec(line);
  if (match) entries.push({ section, path: match[1] });
}

const baseFor = (s: string) =>
  s.startsWith("auth.email.notification.") ? join(ROOT, "supabase") : ROOT;

describe("supabase config email templates", () => {
  it("finds content_path entries at all", () => {
    // A wrong path or regex here would make the assertion below vacuous.
    expect(entries.length).toBeGreaterThan(0);
  });

  it("points every content_path at a file that exists", () => {
    const missing = entries
      .filter((e) => !existsSync(join(baseFor(e.section), e.path)))
      .map((e) => `${e.section}: ${e.path}`);

    expect(missing).toEqual([]);
  });
});
