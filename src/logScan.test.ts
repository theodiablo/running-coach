import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// scripts/log-scan.sql labels paths only from fixed lists (its summary is public);
// a function or table missing from a list would be reported as 'other'.
const root = process.cwd();
const sql = readFileSync(join(root, "scripts", "log-scan.sql"), "utf8");
const lists = [...sql.matchAll(/has\(\[([^\]]*)\]/g)].map(
  (m) => new Set([...m[1].matchAll(/'([a-z0-9_-]+)'/g)].map((q) => q[1])),
);

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

const missingFrom = (names: Iterable<string>, list: Set<string>) =>
  [...names].filter((n) => !list.has(n));

describe("log-scan route labels", () => {
  const functionLists = lists.filter((l) => l.has("coach-agent"));
  const gateway = lists.filter((l) => l.has("app_state"));

  it("finds the lists, functions and tables at all", () => {
    expect(functions.length).toBeGreaterThan(0);
    expect(tables.size).toBeGreaterThan(0);
    expect(functionLists.length).toBe(3);
    expect(gateway.length).toBe(1);
  });

  it("names every edge function in every function list", () => {
    for (const l of functionLists) expect(missingFrom(functions, l)).toEqual([]);
  });

  it("names every table in the gateway list", () => {
    expect(missingFrom(tables, gateway[0])).toEqual([]);
  });
});
