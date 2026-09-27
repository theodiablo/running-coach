import { describe, it, expect } from "vitest";
import { sessionSteps } from "./sessionSteps";

const labels = (s: Parameters<typeof sessionSteps>[0]) => sessionSteps(s).map(x => x.label);
const step = (s: Parameters<typeof sessionSteps>[0], label: string) =>
  sessionSteps(s).find(x => x.label === label)?.detail || "";

describe("sessionSteps", () => {
  it("breaks an interval session into warm-up / workout / cool-down / stretch", () => {
    const s = { type: "INTERVALS", desc: "Intervals — 5x800m at 6:15/km + 90s recovery", km: 5.5, pace: 375 };
    expect(labels(s)).toEqual(["Warm-up", "Workout", "Cool-down", "Stretch"]);
    expect(step(s, "Workout")).toContain("5 × 800 m");
    expect(step(s, "Workout")).toContain("6:15/km");
    expect(step(s, "Workout")).toContain("90s recovery");
  });

  it("parses km-sized reps and their recovery (Hansons strength)", () => {
    const s = { type: "INTERVALS", desc: "Strength — 3x3km at goal pace minus 10s (4:50/km) + 1km jog recovery", km: 10, pace: 290 };
    expect(step(s, "Workout")).toContain("3 × 3 km");
    expect(step(s, "Workout")).toContain("1km jog recovery");
  });

  it("falls back gracefully on coach-added descs with no rep pattern", () => {
    const s = { type: "INTERVALS", desc: "Intervals — repeats at 6:15/km with full recovery", km: 4, pace: 375 };
    expect(step(s, "Workout")).toContain("Repeats");
    expect(step(s, "Workout")).toContain("6:15/km");
  });

  it("describes tempo as a bounded comfortably-hard block", () => {
    const s = { type: "TEMPO", desc: "Tempo run — 5:05/km, comfortably hard", km: 7, pace: 305 };
    expect(labels(s)).toEqual(["Warm-up", "Workout", "Cool-down", "Stretch"]);
    expect(step(s, "Workout")).toContain("~7 km");
  });

  it("adds a fuelling step only to genuinely long runs", () => {
    const long = { type: "LONG", desc: "Long run — easy effort at 6:00/km", km: 24, pace: 360 };
    expect(labels(long)).toContain("Fuel");
    const short = { ...long, km: 9 };
    expect(labels(short)).not.toContain("Fuel");
  });

  it("carries the run/walk ratio into long and walk sessions", () => {
    const long = { type: "LONG", desc: "Long run/walk — run 2 min / walk 1 min, conversational", km: 12, pace: 500 };
    expect(step(long, "Main")).toContain("run 2 min / walk 1 min");
    const walk = { type: "WALK", desc: "Run/walk — run 3 min / walk 1 min, conversational", km: 4, pace: 520 };
    expect(labels(walk)).toEqual(["Warm-up", "Main", "Cool-down", "Stretch"]);
    expect(step(walk, "Main")).toContain("run 3 min / walk 1 min");
  });

  it("reads a sub-minute ratio, in sd or in the desc", () => {
    const sd = { type: "WALK", km: 4, pace: 520, desc: "",
      sd: { kind: "runwalk" as const, variant: "short", runSec: 90, walkSec: 45 } };
    expect(step(sd, "Main")).toContain("run 1 min 30 s / walk 45 s");
    const parsed = { type: "LONG", km: 8, pace: 520,
      desc: "Long run/walk — run 1 min 30 s / walk 45 s, conversational" };
    expect(step(parsed, "Main")).toContain("run 1 min 30 s / walk 45 s");
  });

  it("treats a ratio-less WALK as easy cross-training", () => {
    const s = { type: "WALK", desc: "Cross-training / brisk walk — no impact, easy effort", km: 3, pace: null };
    expect(step(s, "Activity")).toContain("cross-training");
  });

  it("gives race day before/race/after guidance", () => {
    const s = { type: "RACE", desc: "Race Day — 21.1km!", km: 21.1, pace: 300 };
    expect(labels(s)).toEqual(["Before", "Race", "After"]);
    expect(step(s, "Race")).toContain("5:00/km");
  });

  it("keeps easy runs unstructured", () => {
    const s = { type: "EASY", desc: "Easy run — relaxed aerobic effort", km: 5, pace: 375 };
    expect(labels(s)).toEqual(["Run", "Finish"]);
  });

  it("never throws on unknown or empty sessions", () => {
    expect(sessionSteps({})).not.toHaveLength(0);
    expect(sessionSteps({ type: "MYSTERY", desc: "", km: "x", pace: undefined })).not.toHaveLength(0);
  });
});
