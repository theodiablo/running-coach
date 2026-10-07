import { describe, expect, it } from "vitest";
import { ROUTINES, cooldownFor } from "../stretch/routines";
import { PREP_SEC, backTarget, isSideSwitch, positionAt, routineMinutes, routineSteps, stepStartMs, totalMs } from "./stretchEngine";

describe("routineSteps", () => {
  it("splits two-sided moves into left then right", () => {
    const steps = routineSteps(ROUTINES.cooldown);
    expect(steps).toHaveLength(12);
    expect(steps.slice(0, 2)).toEqual([
      { move: "calfWall", sec: 30, side: "left" },
      { move: "calfWall", sec: 30, side: "right" },
    ]);
  });

  it("repeats rounds before the tail", () => {
    const steps = routineSteps(ROUTINES.restday);
    expect(steps).toHaveLength(25);
    expect(steps[12]).toEqual(steps[0]);
    expect(steps[24]).toEqual({ move: "child", sec: 60, side: null });
  });

  it("quotes the minutes the routine cards promise", () => {
    expect(routineMinutes(ROUTINES.cooldown)).toBe(7);
    expect(routineMinutes(ROUTINES.recovery)).toBe(9);
    expect(routineMinutes(ROUTINES.warmup)).toBe(3);
    expect(routineMinutes(ROUTINES.restday)).toBe(15);
  });
});

describe("positionAt", () => {
  const steps = routineSteps(ROUTINES.cooldown);

  it("starts in the prep of the first step", () => {
    expect(positionAt(steps, 0)).toMatchObject({ index: 0, phase: "prep", remainingMs: PREP_SEC * 1000, done: false });
  });

  it("moves to the hold after the prep", () => {
    expect(positionAt(steps, 6000)).toMatchObject({ index: 0, phase: "hold", phaseMs: 30000, remainingMs: 29000 });
  });

  it("catches up across several steps at once", () => {
    expect(positionAt(steps, stepStartMs(steps, 5) + 7000)).toMatchObject({ index: 5, phase: "hold", remainingMs: 28000 });
  });

  it("is done at the end", () => {
    expect(positionAt(steps, totalMs(steps))).toMatchObject({ index: 11, done: true, remainingMs: 0 });
  });
});

describe("cooldownFor", () => {
  it("puts calves first, held longer, after hills", () => {
    const items = cooldownFor("hills").items;
    expect(items.slice(0, 2).map(i => [i.move, i.sec])).toEqual([["calfWall", 45], ["calfBent", 45]]);
    expect(items).toHaveLength(6);
  });

  it("gives hips and hamstrings longer after a hard session", () => {
    const secs = Object.fromEntries(cooldownFor("hard").items.map(i => [i.move, i.sec]));
    expect(secs).toMatchObject({ hipFlexor: 45, hamStrap: 45, calfWall: 30 });
  });
});

describe("navigation helpers", () => {
  const steps = routineSteps(ROUTINES.cooldown);

  it("reads the second side as a switch", () => {
    expect(isSideSwitch(steps, 1)).toBe(true);
    expect(isSideSwitch(steps, 2)).toBe(false);
    expect(isSideSwitch(steps, 0)).toBe(false);
  });

  it("back restarts a hold well under way, else returns to the previous step", () => {
    const start2 = stepStartMs(steps, 2);
    expect(backTarget(steps, positionAt(steps, start2 + 10000))).toBe(start2 + PREP_SEC * 1000);
    expect(backTarget(steps, positionAt(steps, start2 + 6000))).toBe(stepStartMs(steps, 1));
    expect(backTarget(steps, positionAt(steps, 1000))).toBe(0);
  });
});
