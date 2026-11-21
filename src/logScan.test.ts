import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// scripts/log-scan.sql labels paths only from fixed lists (its summary is public);
// a function or table missing from them would be reported as 'other'.
const root = process.cwd();
const sql = readFileSync(join(root, "scripts", "log-scan.sql"), "utf8");
const quoted = new Set([...sql.matchAll(/'([a-z0-9_-]+)'/g)].map((m) => m[1]));

const functions = readdirSync(join(root, "supabase", "functions"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
  .map((d) => d.name);

const tables = new Set<string>();
for (const f of readdirSync(join(root, "supabase", "migrations"))) {
  const text = readFileSync(join(root, "supabase", "migrations", f), "utf8");
  for (const m of text.matchAll(/create table (?:if not exists )?(?:public\.)?"?([a-z_]+)"?/gi)) {
    tables.add(m[1].toLowerCase());
  }
}

describe("log-scan route labels", () => {
  it("finds functions and tables at all", () => {
    expect(functions.length).toBeGreaterThan(0);
    expect(tables.size).toBeGreaterThan(0);
  });

  it("names every edge function", () => {
    expect(functions.filter((f) => !quoted.has(f))).toEqual([]);
  });

  it("names every table", () => {
    expect([...tables].filter((t) => !quoted.has(t))).toEqual([]);
  });
});
