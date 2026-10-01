import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Supabase's GitHub integration bundles each function with no node_modules;
// the root deno.json's "manual" mode breaks that. See docs/release.md.
const FUNCTIONS_DIR = join(process.cwd(), "supabase", "functions");
const functions = readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
  .map((d) => d.name);

describe("edge function deno.json", () => {
  it("finds the functions", () => {
    expect(functions.length).toBeGreaterThan(0);
  });

  it.each(functions)("%s resolves npm: imports without node_modules", (name) => {
    const path = join(FUNCTIONS_DIR, name, "deno.json");
    expect(existsSync(path), `${name}/deno.json is missing`).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).nodeModulesDir).toBe("none");
  });

  it.each(functions)("%s pins npm: imports to an exact version", (name) => {
    const src = readFileSync(join(FUNCTIONS_DIR, name, "index.ts"), "utf8");
    for (const [, spec] of src.matchAll(/["']npm:([^"']+)["']/g)) {
      expect(spec, `${name}: ${spec}`).toMatch(/^(@[^/]+\/)?[^@/]+@\d+\.\d+\.\d+(\/.*)?$/);
    }
  });
});
