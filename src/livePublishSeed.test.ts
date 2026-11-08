import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RESUME_MAX_AGE_MS } from "./constants";

const KT = "android/app/src/main/java/solutions/camboulive/run/LivePublishPlugin.kt";

// The screen-off uploader is seeded once per backgrounding; a shorter expiry
// freezes the public watch page mid-race (docs/live-sharing.md).
describe("LivePublishPlugin seed expiry", () => {
  it("lasts as long as a run can stay live", () => {
    const m = readFileSync(KT, "utf8").match(/SEED_MAX_AGE_MS\s*=\s*([\d_\s*L]+)\n/);
    expect(m).not.toBeNull();
    const ms = Function(`return ${m![1].replace(/_/g, "").replace(/L/g, "")}`)() as number;
    expect(ms).toBe(RESUME_MAX_AGE_MS);
  });
});
