import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RESUME_MAX_AGE_MS } from "./constants";

const KT = "android/app/src/main/java/solutions/camboulive/run/";
const HOUR = 3600_000;

function seedMaxAgeMs(file: string): number {
  const m = readFileSync(KT + file, "utf8").match(/SEED_MAX_AGE_MS\s*=\s*([\d_\s*L]+)\n/);
  expect(m, file).not.toBeNull();
  return Function(`return ${m![1].replace(/_/g, "").replace(/L/g, "")}`)() as number;
}

function appendStartedAtBackstopMs(): number {
  const dir = "supabase/migrations/";
  const latest = readdirSync(dir).sort().reverse()
    .map((f) => readFileSync(dir + f, "utf8"))
    .find((sql) => /function\s+public\.live_publish_append/.test(sql));
  const m = latest?.match(/started_at\s*>\s*now\(\)\s*-\s*interval\s*'(\d+) hours'/);
  expect(m).toBeTruthy();
  return Number(m![1]) * HOUR;
}

// A screen-off run never re-seeds the native engines, so their expiry is a
// whole-run lifetime: shorter, and the watch page freezes mid-race.
describe("native seed expiry", () => {
  it("lets screen-off uploads run as long as the server accepts them", () => {
    expect(seedMaxAgeMs("LivePublishPlugin.kt")).toBe(appendStartedAtBackstopMs());
  });

  it("keeps the workout guide alive for the recovery window", () => {
    expect(seedMaxAgeMs("WorkoutGuidePlugin.kt")).toBe(RESUME_MAX_AGE_MS);
  });
});
