import { describe, it, expect } from "vitest";
import {
  compileWorkout, advanceWorkout, stepAt, stepRemaining, paceVerdict,
  initialWorkoutProgress, WARMUP_SEC, COOLDOWN_SEC, WALK_WARMUP_SEC,
  REP_BAND_SEC_PER_KM, TEMPO_BAND_SEC_PER_KM, RECOVER_DEFAULT_SEC,
  type Workout,
} from "./workout";

describe("compileWorkout", () => {
  it("compiles an sd interval session: warm-up, alternating reps/recoveries, cool-down", () => {
    const w = compileWorkout({
      type: "INTERVALS", desc: "Intervals — 5x800m at 6:15/km + 90s recovery", km: 5.5, pace: 375,
      sd: { kind: "intervals", reps: 5, repM: 800, recover: "90s" },
    })!;
    expect(w.loopFrom).toBeUndefined();
    expect(w.steps[0]).toEqual({ kind: "warmup", sec: WARMUP_SEC });
    expect(w.steps[w.steps.length - 1]).toEqual({ kind: "cooldown", sec: COOLDOWN_SEC });
    const works = w.steps.filter(s => s.kind === "work");
    const recovers = w.steps.filter(s => s.kind === "recover");
    expect(works).toHaveLength(5);
    expect(recovers).toHaveLength(4); // between reps only — no recovery after the last
    expect(works[2]).toEqual({ kind: "work", m: 800, rep: 3, reps: 5, pace: 375, band: REP_BAND_SEC_PER_KM });
    expect(recovers[0]).toEqual({ kind: "recover", sec: 90 });
    // reps/recoveries strictly alternate
    expect(w.steps.slice(1, -1).map(s => s.kind)).toEqual(
      ["work", "recover", "work", "recover", "work", "recover", "work", "recover", "work"]);
  });

  it("maps every recover token", () => {
    const forToken = (recover: "90s" | "90sJog" | "1kmJog" | "jogs") =>
      compileWorkout({ type: "INTERVALS", desc: "", pace: 300,
        sd: { kind: "intervals", reps: 2, repM: 400, recover } })!.steps[2];
    expect(forToken("90s")).toEqual({ kind: "recover", sec: 90 });
    expect(forToken("90sJog")).toEqual({ kind: "recover", sec: 90 });
    expect(forToken("1kmJog")).toEqual({ kind: "recover", m: 1000 });
    expect(forToken("jogs")).toEqual({ kind: "recover", sec: RECOVER_DEFAULT_SEC });
  });

  it("falls back to the canonical desc when sd is absent (older plans)", () => {
    const w = compileWorkout({
      type: "INTERVALS", desc: "Strength — 3x3km at goal pace minus 10s (4:50/km) + 1km jog recovery", km: 10, pace: 290,
    })!;
    const works = w.steps.filter(s => s.kind === "work");
    expect(works).toHaveLength(3);
    expect(works[0].m).toBe(3000);
    expect(w.steps[2]).toEqual({ kind: "recover", m: 1000 });
  });

  it("parses a seconds recovery out of the desc", () => {
    const w = compileWorkout({ type: "INTERVALS", desc: "Intervals — 4x400m at 5:00/km + 60s recovery", pace: 300 })!;
    expect(w.steps[2]).toEqual({ kind: "recover", sec: 60 });
  });

  it("returns null for an interval session with no rep structure", () => {
    expect(compileWorkout({ type: "INTERVALS", desc: "Intervals — repeats at 6:15/km with full recovery", pace: 375 })).toBeNull();
  });

  it("compiles tempo with the row's km as the work block", () => {
    const w = compileWorkout({ type: "TEMPO", desc: "Tempo run — 5:05/km, comfortably hard", km: 7, pace: 305 })!;
    expect(w.steps).toEqual([
      { kind: "warmup", sec: WARMUP_SEC },
      { kind: "work", m: 7000, pace: 305, band: TEMPO_BAND_SEC_PER_KM },
      { kind: "cooldown", sec: COOLDOWN_SEC },
    ]);
  });

  it("keeps a paceless work step unguided rather than dropping the session", () => {
    const w = compileWorkout({ type: "TEMPO", desc: "Tempo run", km: 5, pace: 0 })!;
    expect(w.steps[1]).toEqual({ kind: "work", m: 5000 });
  });

  it("returns null for tempo without a distance", () => {
    expect(compileWorkout({ type: "TEMPO", desc: "Tempo run", km: 0, pace: 305 })).toBeNull();
  });

  it("compiles walk sessions as warm-up + looping run/walk ratio", () => {
    const w = compileWorkout({ type: "WALK", desc: "Run/walk — run 2 min / walk 1 min", km: 4, pace: 0,
      sd: { kind: "runwalk", runMin: 2, walkMin: 1 } })!;
    expect(w.steps).toEqual([
      { kind: "warmup", sec: WALK_WARMUP_SEC },
      { kind: "run", sec: 120 },
      { kind: "walk", sec: 60 },
    ]);
    expect(w.loopFrom).toBe(1);
  });

  it("compiles a run/walk long run as a bare loop, ratio parsed from desc", () => {
    const w = compileWorkout({ type: "LONG", desc: "Long run/walk — run 3 min / walk 1 min, conversational", km: 12 })!;
    expect(w.steps).toEqual([{ kind: "run", sec: 180 }, { kind: "walk", sec: 60 }]);
    expect(w.loopFrom).toBe(0);
  });

  it("has nothing to guide on unstructured sessions", () => {
    expect(compileWorkout({ type: "EASY", desc: "Easy run", km: 5, pace: 360 })).toBeNull();
    expect(compileWorkout({ type: "LONG", desc: "Long run — easy effort", km: 14, pace: 380 })).toBeNull();
    expect(compileWorkout({ type: "RACE", desc: "Race day", km: 10, pace: 290 })).toBeNull();
    expect(compileWorkout({ type: "OTHER", desc: "Cross-training", km: 0, pace: 0 })).toBeNull();
  });

  it("keeps guided warm-up/cool-down inside the prose's promised ranges", () => {
    // plan.steps.intervals/tempo promise 10–15 min warm-up and 5–10 min cool-down.
    expect(WARMUP_SEC).toBeGreaterThanOrEqual(600);
    expect(WARMUP_SEC).toBeLessThanOrEqual(900);
    expect(COOLDOWN_SEC).toBeGreaterThanOrEqual(300);
    expect(COOLDOWN_SEC).toBeLessThanOrEqual(600);
  });
});

describe("advanceWorkout", () => {
  const tempo: Workout = {
    steps: [
      { kind: "warmup", sec: 600 },
      { kind: "work", m: 5000, pace: 300, band: 12 },
      { kind: "cooldown", sec: 300 },
    ],
  };

  it("stays in the warm-up until its moving time elapses", () => {
    const r = advanceWorkout(tempo, initialWorkoutProgress, { km: 1.2, movingSec: 599 });
    expect(r.progress.idx).toBe(0);
    expect(r.entered).toEqual([]);
    expect(r.finished).toBe(false);
  });

  it("advances on the boundary and anchors the next step at the boundary, not at 'now'", () => {
    const r = advanceWorkout(tempo, initialWorkoutProgress, { km: 1.85, movingSec: 612 });
    expect(r.progress.idx).toBe(1);
    expect(r.entered).toEqual([1]);
    // Time boundary → the work block starts at the km reading of this update
    // and at exactly 600 moving seconds.
    expect(r.progress.stepStartKm).toBe(1.85);
    expect(r.progress.stepStartSec).toBe(600);
  });

  it("crosses a distance boundary by cumulative km", () => {
    const inWork = { idx: 1, stepStartKm: 2, stepStartSec: 600, done: false };
    expect(advanceWorkout(tempo, inWork, { km: 6.9, movingSec: 2000 }).progress.idx).toBe(1);
    const r = advanceWorkout(tempo, inWork, { km: 7.01, movingSec: 2050 });
    expect(r.progress.idx).toBe(2);
    expect(r.progress.stepStartKm).toBe(7); // 2 + 5000m, the true boundary
  });

  it("catches up over several boundaries in one call (screen-on after background)", () => {
    const w: Workout = {
      steps: [
        { kind: "work", m: 400, rep: 1, reps: 3 },
        { kind: "work", m: 400, rep: 2, reps: 3 },
        { kind: "work", m: 400, rep: 3, reps: 3 },
      ],
    };
    const r = advanceWorkout(w, initialWorkoutProgress, { km: 0.85, movingSec: 200 });
    expect(r.entered).toEqual([1, 2]);
    expect(r.progress.idx).toBe(2);
    expect(r.progress.stepStartKm).toBeCloseTo(0.8); // each boundary at its true km
  });

  it("anchors a time step entered off a distance boundary at 'now' (conservative)", () => {
    // A single snapshot can't say when the rep actually ended, so the recovery
    // clock starts at the update that detected it — never earlier.
    const w: Workout = { steps: [{ kind: "work", m: 400 }, { kind: "recover", sec: 60 }, { kind: "work", m: 400 }] };
    const r = advanceWorkout(w, initialWorkoutProgress, { km: 0.45, movingSec: 200 });
    expect(r.entered).toEqual([1]);
    expect(r.progress.stepStartSec).toBe(200);
  });

  it("finishes past the final step and never advances again", () => {
    const done = advanceWorkout(tempo, { idx: 2, stepStartKm: 7, stepStartSec: 2000, done: false },
      { km: 7.4, movingSec: 2301 });
    expect(done.finished).toBe(true);
    expect(done.progress.done).toBe(true);
    const again = advanceWorkout(tempo, done.progress, { km: 9, movingSec: 4000 });
    expect(again.entered).toEqual([]);
    expect(again.finished).toBe(false);
  });

  it("loops a run/walk workout indefinitely", () => {
    const w: Workout = { steps: [{ kind: "run", sec: 120 }, { kind: "walk", sec: 60 }], loopFrom: 0 };
    // 600s = 3 full 180s cycles (540s) + 60s into the 4th run segment.
    const r = advanceWorkout(w, initialWorkoutProgress, { km: 1.4, movingSec: 600 });
    expect(r.finished).toBe(false);
    expect(r.progress.idx).toBe(6);
    expect(stepAt(w, r.progress.idx)!.kind).toBe("run");
    expect(r.progress.stepStartSec).toBe(540);
    expect(stepRemaining(stepAt(w, r.progress.idx)!, r.progress, { km: 1.4, movingSec: 600 })).toEqual({ sec: 60 });
  });
});

describe("stepAt", () => {
  it("wraps through the loop", () => {
    const w: Workout = {
      steps: [{ kind: "warmup", sec: 300 }, { kind: "run", sec: 120 }, { kind: "walk", sec: 60 }],
      loopFrom: 1,
    };
    expect(stepAt(w, 0)!.kind).toBe("warmup");
    expect(stepAt(w, 3)!.kind).toBe("run");
    expect(stepAt(w, 4)!.kind).toBe("walk");
    expect(stepAt(w, 5)!.kind).toBe("run");
  });

  it("returns null past the end of a non-looping workout", () => {
    expect(stepAt({ steps: [{ kind: "work", m: 800 }] }, 1)).toBeNull();
  });
});

describe("stepRemaining", () => {
  it("reports remaining metres of a distance step", () => {
    const p = { idx: 1, stepStartKm: 2, stepStartSec: 600, done: false };
    expect(stepRemaining({ kind: "work", m: 5000 }, p, { km: 4.25, movingSec: 1300 })).toEqual({ m: 2750 });
  });

  it("reports remaining seconds of a time step, clamped at zero", () => {
    const p = { idx: 0, stepStartKm: 0, stepStartSec: 0, done: false };
    expect(stepRemaining({ kind: "warmup", sec: 600 }, p, { km: 1, movingSec: 480 })).toEqual({ sec: 120 });
    expect(stepRemaining({ kind: "warmup", sec: 600 }, p, { km: 2, movingSec: 700 })).toEqual({ sec: 0 });
  });
});

describe("paceVerdict", () => {
  const step = { kind: "work" as const, m: 800, pace: 300, band: 15 };
  it("bands the verdict around the target", () => {
    expect(paceVerdict(step, 316)).toBe("slow");
    expect(paceVerdict(step, 315)).toBe("on");
    expect(paceVerdict(step, 300)).toBe("on");
    expect(paceVerdict(step, 285)).toBe("on");
    expect(paceVerdict(step, 284)).toBe("fast");
  });
  it("is null with no target or no live pace yet", () => {
    expect(paceVerdict({ kind: "recover", sec: 90 }, 300)).toBeNull();
    expect(paceVerdict(step, 0)).toBeNull();
  });
});
