// The stretch player's schedule: a routine flattened into steps, each a
// "get into position" prep followed by the hold. Pure, and read from elapsed
// time rather than counted ticks, so a screen that slept catches up.

import { MOVE_POSTURE } from "../stretch/routines";
import type { MoveId, Posture, Routine } from "../stretch/routines";

/** Prep before a move in the same posture as the last one (or the other side). */
export const PREP_SEC = 5;
/** Extra prep per level crossed: standing to kneeling is one, standing to lying two. */
export const PREP_PER_LEVEL_SEC = 5;
const LEVEL: Record<Posture, number> = { stand: 0, kneel: 1, lie: 2 };

export type StretchSide = "left" | "right";
export type StretchStep = { move: MoveId; sec: number; side: StretchSide | null; prepSec: number };

/** Seconds to get from one move into the next; a routine starts standing. */
export function prepSec(from: MoveId | null, to: MoveId): number {
  const a = from ? LEVEL[MOVE_POSTURE[from]] : LEVEL.stand;
  return PREP_SEC + PREP_PER_LEVEL_SEC * Math.abs(LEVEL[MOVE_POSTURE[to]] - a);
}

export function routineSteps(r: Routine): StretchStep[] {
  const out: StretchStep[] = [];
  const push = ({ move, sec, sides }: Routine["items"][number]) => {
    const first = prepSec(out.at(-1)?.move ?? null, move);
    if (sides === 2) out.push({ move, sec, side: "left", prepSec: first }, { move, sec, side: "right", prepSec: PREP_SEC });
    else out.push({ move, sec, side: null, prepSec: first });
  };
  for (let k = 0; k < (r.rounds ?? 1); k++) r.items.forEach(push);
  (r.tail ?? []).forEach(push);
  return out;
}

const stepMs = (s: StretchStep) => (s.prepSec + s.sec) * 1000;

export function totalMs(steps: StretchStep[]): number {
  return steps.reduce((sum, s) => sum + stepMs(s), 0);
}

/** Whole minutes a routine takes, prep included. */
export function routineMinutes(r: Routine): number {
  return Math.max(1, Math.round(totalMs(routineSteps(r)) / 60000));
}

/** Where step `index` starts, in ms from the start of the routine. */
export function stepStartMs(steps: StretchStep[], index: number): number {
  let ms = 0;
  for (let i = 0; i < index && i < steps.length; i++) ms += stepMs(steps[i]);
  return ms;
}

export type StretchPosition = {
  index: number;
  phase: "prep" | "hold";
  /** Length of the current phase, and what's left of it. */
  phaseMs: number;
  remainingMs: number;
  done: boolean;
};

export function positionAt(steps: StretchStep[], elapsedMs: number): StretchPosition {
  let start = 0;
  const t = Math.max(0, elapsedMs);
  for (let i = 0; i < steps.length; i++) {
    const prepEnd = start + steps[i].prepSec * 1000;
    const end = start + stepMs(steps[i]);
    if (t < prepEnd) return { index: i, phase: "prep", phaseMs: steps[i].prepSec * 1000, remainingMs: prepEnd - t, done: false };
    if (t < end) return { index: i, phase: "hold", phaseMs: steps[i].sec * 1000, remainingMs: end - t, done: false };
    start = end;
  }
  const last = Math.max(0, steps.length - 1);
  return { index: last, phase: "hold", phaseMs: (steps[last]?.sec ?? 0) * 1000, remainingMs: 0, done: true };
}

/** The second side of a two-sided move: the prep reads "switch sides", not a new stretch. */
export function isSideSwitch(steps: StretchStep[], index: number): boolean {
  const prev = steps[index - 1];
  return !!prev && prev.move === steps[index]?.move && steps[index].side === "right";
}

/** Where "back" lands: the start of this hold if well into it, else the previous step. */
export function backTarget(steps: StretchStep[], pos: StretchPosition): number {
  const start = stepStartMs(steps, pos.index);
  const intoHold = pos.phase === "hold" ? pos.phaseMs - pos.remainingMs : 0;
  if (!pos.done && pos.phase === "hold" && intoHold > 3000) return start + steps[pos.index].prepSec * 1000;
  return stepStartMs(steps, Math.max(0, pos.done ? pos.index : pos.index - 1));
}
