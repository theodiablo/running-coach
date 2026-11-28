import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// The race field is the first cross-user read of runner data (docs/race-field.md).
// These pin its privilege surface across every migration, so a later one can't widen it quietly.
const DIR = join(process.cwd(), "supabase", "migrations");
const strip = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const all = readdirSync(DIR).filter(n => n.endsWith(".sql")).sort()
  .map(f => strip(readFileSync(join(DIR, f), "utf8"))).join("\n");
const statements = all.split(";").map(s => s.replace(/\s+/g, " ").trim().toLowerCase());
const on = (table: string) => statements.filter(s => new RegExp(`\\bon (?:table )?(?:public\\.)?${table}\\b`).test(s));

describe("race field privileges", () => {
  it("has exactly one, owner-only policy", () => {
    const policies = on("race_field_members").filter(s => /^create policy/.test(s));
    expect(policies).toHaveLength(1);
    expect(policies[0]).toContain("using ((select auth.uid()) = user_id)");
    expect(policies[0]).toContain("with check ((select auth.uid()) = user_id)");
    expect(on("race_field_members").some(s => /^alter policy/.test(s))).toBe(false);
  });

  it("states its grants both ways and keeps anon out", () => {
    const grants = on("race_field_members").filter(s => /^(grant|revoke)/.test(s));
    expect(grants).toEqual([
      "revoke all on public.race_field_members from anon, authenticated",
      "grant select, delete on public.race_field_members to authenticated",
      "grant insert (user_id, edition_id, visibility, goal_sec) on public.race_field_members to authenticated",
      "grant update (visibility, goal_sec) on public.race_field_members to authenticated",
    ]);
  });

  it("never grants a client role the entitlement columns, and grants public_name", () => {
    const clientGrants = on("profiles").filter(s => /^grant .* to .*\b(anon|authenticated)\b/.test(s));
    expect(clientGrants.filter(s => /premium_(until|since)/.test(s))).toEqual([]);
    expect(clientGrants).toContain("grant update (public_name) on public.profiles to authenticated");
  });

  it("cascades both foreign keys, so account deletion leaves nothing", () => {
    const table = statements.find(s => s.startsWith("create table if not exists public.race_field_members"));
    expect(table).toMatch(/user_id uuid not null references auth\.users\(id\) on delete cascade/);
    expect(table).toMatch(/edition_id text not null references public\.race_editions\(id\) on delete cascade/);
  });

  it("keeps race_field off anon and the guard trigger as invoker", () => {
    expect(statements).toContain("revoke all on function public.race_field(text) from public, anon");
    expect(statements.some(s => /grant execute on function public\.race_field\(text\) to .*anon/.test(s))).toBe(false);
    const guard = statements.find(s => s.startsWith("create or replace function public.race_field_members_guard()"));
    expect(guard).toMatch(/security invoker/);
  });

  it("leaves a duplicate join out of the cap, so it reads as a change (23505), not as the limit", () => {
    const guard = all.match(/function public\.race_field_members_guard\(\)\s+returns trigger[\s\S]*?\$\$;/g)?.at(-1);
    expect(guard).toMatch(/m\.edition_id <> new\.edition_id/);
  });
  it("shows names only to a runner who joined, and never an id or a date", () => {
    const fn = all.match(/function public\.race_field\(p_edition_id text\)\s+returns jsonb[\s\S]*?\$\$;/g)?.at(-1) ?? "";
    expect(fn).toMatch(/'named', case when not v_joined then '\[\]'::jsonb/);
    const built = [...fn.matchAll(/jsonb_build_object\(([^;]*?)\)/g)].map(m => m[1]).join(" ");
    expect(built).not.toMatch(/'(id|user_?id|created_at|updated_at)'/i);
  });
});
