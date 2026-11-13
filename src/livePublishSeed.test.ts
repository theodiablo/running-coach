import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RESUME_MAX_AGE_MS } from "./constants";
import { LIVE_PUBLISH_INTERVAL_MS, publishIntervalMs } from "./live/publisher";

const KT = "android/app/src/main/java/solutions/camboulive/run/";
const HOUR = 3600_000;

function seedMaxAgeMs(file: string): number {
  const m = readFileSync(KT + file, "utf8").match(/SEED_MAX_AGE_MS\s*=\s*([\d_\s*L]+)\n/);
  expect(m, file).not.toBeNull();
  return Function(`return ${m![1].replace(/_/g, "").replace(/L/g, "")}`)() as number;
}

function appendStartedAtBackstopMs(): number {
  const dir = "supabase/migrations/";
  const def = /create\s+(or\s+replace\s+)?function\s+public\.live_publish_append\s*\(/i;
  const sql = readdirSync(dir).sort().reverse()
    .map((f) => readFileSync(dir + f, "utf8"))
    .find((s) => def.test(s));
  const start = sql?.search(def) ?? -1;
  const body = start < 0 ? "" : sql!.slice(start, sql!.indexOf("$$;", start));
  const m = body.match(/started_at\s*>\s*now\(\)\s*-\s*interval\s*'(\d+) hours'/);
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

// The screen-off uploader takes over from the JS publisher mid-run, so the two
// must keep one cadence and one backoff on a failing link.
describe("native upload cadence", () => {
  const kt = () => readFileSync(KT + "LivePublishPlugin.kt", "utf8");
  const num = (name: string) => {
    const m = kt().match(new RegExp(`${name}\\s*=\\s*([\\d_]+)L?\\n`));
    expect(m, name).not.toBeNull();
    return Number(m![1].replace(/_/g, ""));
  };

  it("matches the JS publisher's interval and backoff cap", () => {
    expect(num("UPLOAD_INTERVAL_MS")).toBe(LIVE_PUBLISH_INTERVAL_MS);
    expect(num("UPLOAD_INTERVAL_MS") * 2 ** num("MAX_BACKOFF_SHIFT")).toBe(publishIntervalMs(99));
  });
});
