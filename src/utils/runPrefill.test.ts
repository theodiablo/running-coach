import { describe, expect, it } from "vitest";
import { isRecordedArrival } from "./runPrefill";

// Which log screen a hand-off lands on: a device's measurement is reviewed, everything else is typed.
describe("isRecordedArrival", () => {
  it.each(["gps", "indoor", "watch"])("reviews a %s arrival", source => {
    expect(isRecordedArrival({ source } as never)).toBe(true);
  });
  it("types in a plan session's estimate, a bare log and no prefill at all", () => {
    expect(isRecordedArrival({ date: "2026-11-25", km: 8, pace: 310, session: null })).toBe(false);
    expect(isRecordedArrival({})).toBe(false);
    expect(isRecordedArrival(null)).toBe(false);
  });
});
