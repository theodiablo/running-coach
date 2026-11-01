import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// CLAUDE.md: public functions pin `search_path = ''`; a security definer one is
// service-role-only unless the client is its intended caller.
const DIR = join(process.cwd(), "supabase", "migrations");
const CLIENT_CALLABLE_DEFINERS = new Set(["delete_my_account"]);

const strip = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const files = readdirSync(DIR).filter((n) => n.endsWith(".sql")).sort();

interface Fn { definer: boolean; pinned: boolean; trigger: boolean; revoked: Set<string>; file: string }

const unparsed: string[] = [];

function finalFunctions(): Map<string, Fn> {
  const fns = new Map<string, Fn>();
  const CREATE = /create\s+(?:or\s+replace\s+)?function\s+(?:"?public"?\.)?"?(\w+)"?\s*\(([\s\S]*?)\$(\w*)\$[\s\S]*?\$\3\$([^;]*);/gi;
  const ALTER = /alter\s+function\s+(?:"?public"?\.)?"?(\w+)"?\s*\([^)]*\)\s+set\s+search_path\s*(?:=|to)\s*''/gi;
  const DROP = /drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?"?(\w+)"?/gi;
  const SECURITY = /alter\s+function\s+(?:public\.)?"?(\w+)"?\s*\([^)]*\)\s+security\s+(definer|invoker)/gi;
  const ACL = /\b(revoke|grant)\s+(?:all|execute)[^;]*?\bon\s+function\s+([^;]+?)\s+(from|to)\s+([^;]+);/gi;
  for (const f of files) {
    const sql = strip(readFileSync(join(DIR, f), "utf8"));
    const events: [number, () => void][] = [];
    const declared = [...sql.matchAll(/\bcreate\s+(?:or\s+replace\s+)?function\b/gi)].length;
    const parsed = [...sql.matchAll(CREATE)].length;
    if (parsed !== declared) unparsed.push(`${f}: ${declared - parsed} of ${declared}`);
    for (const m of sql.matchAll(CREATE)) {
      const [, name, sig, , tail] = m;
      const header = `${sig} ${tail}`;
      events.push([m.index!, () => fns.set(name, {
        definer: /security\s+definer/i.test(header),
        pinned: /set\s+search_path\s*(?:=|to)\s*''/i.test(header),
        trigger: /returns\s+trigger/i.test(sig),
        revoked: fns.get(name)?.revoked ?? new Set(),
        file: f,
      })]);
    }
    for (const m of sql.matchAll(DROP)) events.push([m.index!, () => fns.delete(m[1])]);
    for (const m of sql.matchAll(ALTER)) events.push([m.index!, () => { const fn = fns.get(m[1]); if (fn) fn.pinned = true; }]);
    for (const m of sql.matchAll(SECURITY)) events.push([m.index!, () => { const fn = fns.get(m[1]); if (fn) fn.definer = m[2].toLowerCase() === "definer"; }]);
    for (const m of sql.matchAll(ACL)) {
      const names = [...m[2].matchAll(/(?:public\.)?"?(\w+)"?\s*\(/g)].map((n) => n[1]);
      const roles = m[4].split(",").map((r) => r.trim().toLowerCase().replace(/"/g, ""));
      events.push([m.index!, () => names.forEach((n) => {
        const fn = fns.get(n);
        roles.forEach((r) => (m[1].toLowerCase() === "revoke" ? fn?.revoked.add(r) : fn?.revoked.delete(r)));
      })]);
    }
    events.sort((a, b) => a[0] - b[0]).forEach(([, apply]) => apply());
  }
  return fns;
}

// Final text of every RLS policy, keyed by table + name; an alter replaces only the clauses it names.
function finalPolicies(): Map<string, { using: string; check: string; file: string }> {
  const pols = new Map<string, { using: string; check: string; file: string }>();
  const STMT = /\b(create|alter|drop)\s+policy\s+(?:if\s+exists\s+)?"([^"]+)"\s+on\s+(?:"?public"?\.)?"?(\w+)"?([^;]*);/gi;
  const clause = (body: string, kw: "using" | "with\\s+check") => {
    const m = new RegExp(`\\b${kw}\\s*\\(`, "i").exec(body);
    if (!m) return undefined;
    let depth = 1, i = m.index + m[0].length;
    for (; i < body.length && depth; i++) depth += body[i] === "(" ? 1 : body[i] === ")" ? -1 : 0;
    return body.slice(m.index, i);
  };
  for (const f of files) {
    for (const m of strip(readFileSync(join(DIR, f), "utf8")).matchAll(STMT)) {
      const [, verb, name, table, body] = m;
      const key = `${table}."${name}"`;
      if (verb.toLowerCase() === "drop") { pols.delete(key); continue; }
      const prev = verb.toLowerCase() === "alter" ? pols.get(key) : undefined;
      pols.set(key, {
        using: clause(body, "using") ?? prev?.using ?? "",
        check: clause(body, "with\\s+check") ?? prev?.check ?? "",
        file: f,
      });
    }
  }
  return pols;
}

describe("migration policy conventions", () => {
  it("wraps auth.uid() in a subquery in every RLS policy", () => {
    const pols = finalPolicies();
    expect(pols.size).toBeGreaterThan(20);
    const bare = (s: string) => /\bauth\.uid\(\)/i.test(s.replace(/\bselect\s+auth\.uid\(\)/gi, ""));
    const perRow = [...pols]
      .filter(([, p]) => bare(p.using) || bare(p.check))
      .map(([k, p]) => `${k} (${p.file})`);
    // Fix with (select auth.uid()); a bare call is re-evaluated per row (advisor lint 0003).
    expect(perRow).toEqual([]);
  });
});

describe("migration function conventions", () => {
  const fns = finalFunctions();

  it("parses every function a migration creates", () => {
    expect(fns.size).toBeGreaterThan(10);
    // A body shape the parser doesn't know (begin atomic, a string body) must fail here, not pass silently.
    expect(unparsed).toEqual([]);
  });

  it("pins search_path to '' on every public function", () => {
    const loose = [...fns].filter(([, fn]) => !fn.pinned).map(([n, fn]) => `${n} (${fn.file})`);
    // Fix with: alter function public.<name>(<args>) set search_path = '';
    expect(loose).toEqual([]);
  });

  it("keeps security definer functions off the client roles", () => {
    const open = [...fns]
      .filter(([n, fn]) => fn.definer && !fn.trigger && !CLIENT_CALLABLE_DEFINERS.has(n))
      .filter(([, fn]) => !["public", "anon", "authenticated"].every((r) => fn.revoked.has(r)))
      .map(([n, fn]) => `${n} (${fn.file})`);
    // Fix with: revoke execute on function public.<name>(<args>) from public, anon, authenticated;
    expect(open).toEqual([]);
  });
});
