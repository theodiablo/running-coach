import { describe, it, expect } from "vitest";
import { compileWorkout, type Workout } from "./workout";
import { DEFAULT_SPEC, compileSpec, isOpenSpec, readSpec, specFromSession, specWantsAudio, zoneBpm } from "./workoutSpec";

// Drop the per-kind verdict bands: the spec path takes the runner's leeway instead.
const shape = (w: Workout | null) => w && { ...w, steps: w.steps.map(({ band: _b, ...s }) => { void _b; return s; }) };

const SESSIONS = {
  intervals: { type: "INTERVALS", desc: "Intervals — 5x800m at 6:15/km + 90s recovery", km: 5.5, pace: 375,
    sd: { kind: "intervals" as const, reps: 5, repM: 800, recover: "90s" as const } },
  kmJog: { type: "INTERVALS", desc: "", pace: 300, sd: { kind: "intervals" as const, reps: 3, repM: 1000, recover: "1kmJog" as const } },
  tempo: { type: "TEMPO", desc: "Tempo 6 km", km: 6, pace: 295 },
  walk: { type: "WALK", desc: "", sd: { kind: "runwalk" as const, runSec: 90, walkSec: 60 } },
  longRw: { type: "LONG", desc: "", km: 14, sd: { kind: "runwalk" as const, runSec: 240, walkSec: 60 } },
};

describe("specFromSession → compileSpec", () => {
  it.each(Object.entries(SESSIONS))("reproduces compileWorkout's schedule for %s", (_name, s) => {
    const fromSpec = compileSpec(specFromSession(s), { band: 10 });
    expect(shape(fromSpec)).toEqual(shape(compileWorkout(s)));
  });

  it("carries the plan's pace and the session type's HR zone", () => {
    expect(specFromSession(SESSIONS.tempo)).toMatchObject({ type: "tempo", pace: 295, hrZone: [3, 4], blockKm: 6 });
    expect(specFromSession(SESSIONS.intervals)).toMatchObject({ type: "intervals", reps: 5, repM: 800, recUnit: "sec", recSec: 90, hrZone: [4, 5] });
    expect(specFromSession(SESSIONS.kmJog)).toMatchObject({ recUnit: "m", recM: 1000 });
    expect(specFromSession(SESSIONS.walk)).toMatchObject({ type: "runwalk", runSec: 90, walkSec: 60, warmMin: 5, pace: null });
  });

  it("turns an unstructured session into a regular run with its distance", () => {
    const spec = specFromSession({ type: "EASY", desc: "Easy run", km: 8, pace: 340 });
    expect(spec).toMatchObject({ type: "regular", goal: "km", goalKm: 8, pace: 340, hrZone: [2, 2] });
    expect(compileSpec(spec, { band: 10 }).steps).toEqual([{ kind: "steady", m: 8000, pace: 340, band: 10 }]);
  });

  it("starts audio on for structured sessions only", () => {
    expect(specWantsAudio(specFromSession(SESSIONS.tempo))).toBe(true);
    expect(specWantsAudio(specFromSession(SESSIONS.walk))).toBe(true);
    expect(specWantsAudio(specFromSession({ type: "EASY", desc: "", km: 8, pace: 340 }))).toBe(false);
  });
});

describe("compileSpec", () => {
  const hr = { lo: 150, hi: 170 };

  it("puts pace and HR targets on work steps only", () => {
    const w = compileSpec({ ...DEFAULT_SPEC, type: "intervals", reps: 2, pace: 260 }, { band: 15, hr });
    expect(w.steps.map(s => s.kind)).toEqual(["warmup", "work", "recover", "work", "cooldown"]);
    expect(w.steps[1]).toMatchObject({ pace: 260, band: 15, hrLo: 150, hrHi: 170 });
    expect(w.steps[2]).toEqual({ kind: "recover", sec: 90 });
    expect(w.steps[0]).toEqual({ kind: "warmup", sec: 720 });
  });

  it("bounds by time when the runner picks time", () => {
    const tempo = compileSpec({ ...DEFAULT_SPEC, type: "tempo", blockUnit: "min", blockMin: 20, warmMin: 0, coolMin: 0 }, { band: 10 });
    expect(tempo.steps).toEqual([{ kind: "work", sec: 1200 }]);
    const reps = compileSpec({ ...DEFAULT_SPEC, type: "intervals", reps: 1, repUnit: "sec", repSec: 180, warmMin: 0, coolMin: 0 }, { band: 10 });
    expect(reps.steps).toEqual([{ kind: "work", sec: 180, rep: 1, reps: 1 }]);
  });

  it("compiles a regular run to one steady step: open, distance or time", () => {
    expect(compileSpec(DEFAULT_SPEC, { band: 10 }).steps).toEqual([{ kind: "steady" }]);
    expect(compileSpec({ ...DEFAULT_SPEC, goal: "time", goalMin: 45 }, { band: 10 }).steps).toEqual([{ kind: "steady", sec: 2700 }]);
  });

  it("loops run/walk after the warm-up, with no pace target", () => {
    const w = compileSpec({ ...DEFAULT_SPEC, type: "runwalk", warmMin: 5, pace: 330 }, { band: 10, hr });
    expect(w.loopFrom).toBe(1);
    expect(w.steps[1]).toEqual({ kind: "run", sec: 120, hrLo: 150, hrHi: 170 });
    expect(w.steps[2]).toEqual({ kind: "walk", sec: 60 });
  });
});

describe("isOpenSpec", () => {
  it("is open only with no goal, no pace and no zone", () => {
    expect(isOpenSpec(DEFAULT_SPEC)).toBe(true);
    expect(isOpenSpec({ ...DEFAULT_SPEC, pace: 300 })).toBe(false);
    expect(isOpenSpec({ ...DEFAULT_SPEC, hrZone: [2, 2] })).toBe(false);
    expect(isOpenSpec({ ...DEFAULT_SPEC, goal: "km" })).toBe(false);
    expect(isOpenSpec({ ...DEFAULT_SPEC, type: "tempo" })).toBe(false);
  });
});

describe("readSpec", () => {
  it("defaults anything missing or malformed", () => {
    expect(readSpec(undefined)).toEqual(DEFAULT_SPEC);
    expect(readSpec({ type: "sprint", goal: "far", pace: -3, hrZone: [5, 2], reps: "6" })).toEqual(DEFAULT_SPEC);
  });

  it("keeps a valid stored spec", () => {
    const stored = { ...DEFAULT_SPEC, type: "tempo", pace: 290, hrZone: [3, 4], blockUnit: "min", blockMin: 25 };
    expect(readSpec(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });
});

describe("zoneBpm", () => {
  it("uses Karvonen on the runner's profile", () => {
    expect(zoneBpm([3, 4], { maxHR: 190, restHR: 55 })).toEqual({ lo: 150, hi: 177 });
  });
  it("is null without a max HR or a zone", () => {
    expect(zoneBpm([3, 4], { restHR: 55 })).toBeNull();
    expect(zoneBpm(null, { maxHR: 190, restHR: 55 })).toBeNull();
  });
});
