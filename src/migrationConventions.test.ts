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

function finalFunctions(): Map<string, Fn> {
  const fns = new Map<string, Fn>();
  const CREATE = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\$(\w*)\$[\s\S]*?\$\3\$([^;]*);/gi;
  const ALTER = /alter\s+function\s+(?:public\.)?"?(\w+)"?\s*\([^)]*\)\s+set\s+search_path\s*(?:=|to)\s*''/gi;
  const DROP = /drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?"?(\w+)"?/gi;
  const SECURITY = /alter\s+function\s+(?:public\.)?"?(\w+)"?\s*\([^)]*\)\s+security\s+(definer|invoker)/gi;
  const REVOKE = /revoke\s+(?:all|execute)[^;]*?on\s+function\s+(?:public\.)?"?(\w+)"?\s*\([^)]*\)\s+from\s+([^;]+);/gi;
  for (const f of files) {
    const sql = strip(readFileSync(join(DIR, f), "utf8"));
    const events: [number, () => void][] = [];
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
    for (const m of sql.matchAll(REVOKE)) {
      events.push([m.index!, () => {
        const fn = fns.get(m[1]);
        m[2].split(",").map((r) => r.trim().toLowerCase()).forEach((r) => fn?.revoked.add(r));
      }]);
    }
    events.sort((a, b) => a[0] - b[0]).forEach(([, apply]) => apply());
  }
  return fns;
}

describe("migration function conventions", () => {
  const fns = finalFunctions();

  it("parses the functions at all", () => {
    expect(fns.size).toBeGreaterThan(10);
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
