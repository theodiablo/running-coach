import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// This project's default privileges give service_role no SELECT/INSERT on new
// tables, and supabase-js reports the denial as `{ data: null, error }` rather
// than throwing, so a missing grant reads as "no row" in production. Every
// table an edge function touches as service_role must be granted explicitly.

const ROOT = process.cwd();
const FUNCTIONS_DIR = join(ROOT, "supabase", "functions");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

// Receivers that carry the caller's JWT; RLS and the client-role grants apply.
const USER_CLIENTS = new Set(["userClient"]);

type Priv = "SELECT" | "INSERT" | "UPDATE" | "DELETE";
const ALL: Priv[] = ["SELECT", "INSERT", "UPDATE", "DELETE"];

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

const sourceFiles = walk(FUNCTIONS_DIR).filter(
  (f) => /\.(ts|mjs)$/.test(f) && !/\.test\./.test(f),
);

const stripSqlComments = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

function grantedToServiceRole(): Map<string, Set<Priv>> {
  const granted = new Map<string, Set<Priv>>();
  const GRANT = /\bgrant\s+([\s\S]+?)\s+on\s+(?:table\s+)?([\s\S]+?)\s+to\s+([\s\S]+?);/gi;
  for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql")).sort()) {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    for (const [, privs, targets, roles] of sql.matchAll(GRANT)) {
      if (!/\bservice_role\b/i.test(roles)) continue;
      if (/^\s*(function|all\s+(tables|functions|sequences)|schema|sequence)\b/i.test(targets)) continue;
      const list = /^\s*all(\s+privileges)?\s*$/i.test(privs)
        ? ALL
        : privs.split(",").map((p) => p.trim().toUpperCase() as Priv).filter((p) => ALL.includes(p));
      for (const t of targets.split(",")) {
        const name = t.trim().replace(/^public\./i, "").replace(/"/g, "");
        const set = granted.get(name) ?? new Set<Priv>();
        list.forEach((p) => set.add(p));
        granted.set(name, set);
      }
    }
  }
  return granted;
}

// The privileges a supabase-js chain needs, read up to the end of its statement.
function needed(chain: string): Priv[] {
  const out = new Set<Priv>();
  if (/\.select\(/.test(chain)) out.add("SELECT");
  if (/\.insert\(/.test(chain)) out.add("INSERT");
  if (/\.upsert\(/.test(chain)) { out.add("INSERT"); out.add("UPDATE"); }
  if (/\.update\(/.test(chain)) out.add("UPDATE");
  if (/\.delete\(/.test(chain)) out.add("DELETE");
  // update/delete/upsert with a filter or returning rows also read the table.
  if (out.size && !out.has("SELECT") && /\.(eq|neq|in|lt|lte|gt|gte|is|match|filter)\(/.test(chain)) out.add("SELECT");
  return [...out];
}

interface Use { file: string; table: string; privs: Priv[] }

function serviceRoleUses(): Use[] {
  const uses: Use[] = [];
  const FROM = /([A-Za-z_$][\w$]*)(\(\))?\s*\.from\(\s*["']([a-z0-9_]+)["']\s*\)/g;
  for (const file of sourceFiles) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(FROM)) {
      const receiver = m[1];
      if (USER_CLIENTS.has(receiver) || receiver === "storage" || receiver === "Array") continue;
      const rest = src.slice(m.index! + m[0].length);
      const end = rest.search(/;|\n\s*\n/);
      uses.push({
        file: relative(ROOT, file),
        table: m[3],
        privs: needed(rest.slice(0, end === -1 ? undefined : end)),
      });
    }
  }
  return uses;
}

describe("service_role table grants", () => {
  const granted = grantedToServiceRole();
  const uses = serviceRoleUses();

  it("finds service-role table access and grants at all", () => {
    // A broken pattern here would make the real assertion vacuously pass.
    expect(uses.length).toBeGreaterThan(10);
    expect(granted.size).toBeGreaterThan(10);
  });

  it("grants service_role every privilege an edge function uses", () => {
    const missing = uses.flatMap(({ file, table, privs }) => {
      const have = granted.get(table) ?? new Set<Priv>();
      const lacking = privs.filter((p) => !have.has(p));
      return lacking.length ? [`${file}: ${table} needs ${lacking.join(", ")}`] : [];
    });
    // Fix with a new migration: grant <privs> on public.<table> to service_role;
    expect([...new Set(missing)]).toEqual([]);
  });
});
