import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards on `supabase/migrations` filenames.
 *
 * Supabase keys applied migrations by the version prefix alone, so two files
 * sharing one prefix are indistinguishable to it: the second is treated as
 * already applied and is silently skipped, forever. That happened on
 * 2026-07-26, when `db_backup_role` and `profiles_email_sync` were both
 * hand-numbered `20260726120000` and the email-sync trigger never reached the
 * database. Nothing failed; the migration simply never ran.
 *
 * These are filename checks only. They cost nothing and turn that class of
 * mistake into a red CI run on the pull request that introduces it.
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const FILENAME = /^(\d{14})_([a-z0-9_]+)\.sql$/;

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

describe("supabase migrations", () => {
  it("finds migration files at all", () => {
    // A wrong path here would make every other assertion vacuously pass.
    expect(files.length).toBeGreaterThan(0);
  });

  it("names every file <14-digit UTC timestamp>_<snake_case>.sql", () => {
    const bad = files.filter((f) => !FILENAME.test(f));
    expect(bad).toEqual([]);
  });

  it("never reuses a version prefix", () => {
    const byVersion = new Map<string, string[]>();
    for (const f of files) {
      const version = FILENAME.exec(f)?.[1];
      if (!version) continue;
      byVersion.set(version, [...(byVersion.get(version) ?? []), f]);
    }

    const collisions = [...byVersion.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([version, names]) => `${version}: ${names.join(", ")}`);

    // If this fails, renumber the migration that has NOT been applied yet.
    // Never renumber one that has already reached Supabase.
    expect(collisions).toEqual([]);
  });

  it("uses plausible timestamps rather than placeholders", () => {
    for (const f of files) {
      const version = FILENAME.exec(f)?.[1];
      if (!version) continue;
      const month = Number(version.slice(4, 6));
      const day = Number(version.slice(6, 8));
      const hour = Number(version.slice(8, 10));
      const minute = Number(version.slice(10, 12));
      const second = Number(version.slice(12, 14));

      expect(month, `${f} month`).toBeGreaterThanOrEqual(1);
      expect(month, `${f} month`).toBeLessThanOrEqual(12);
      expect(day, `${f} day`).toBeGreaterThanOrEqual(1);
      expect(day, `${f} day`).toBeLessThanOrEqual(31);
      expect(hour, `${f} hour`).toBeLessThanOrEqual(23);
      expect(minute, `${f} minute`).toBeLessThanOrEqual(59);
      expect(second, `${f} second`).toBeLessThanOrEqual(59);
    }
  });
});
