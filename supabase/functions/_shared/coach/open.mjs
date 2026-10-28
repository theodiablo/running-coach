// Open plans (no race date): the block length, the checkpoint session's one
// English sentence and the coach's GOAL line. Plain dependency-free ESM like
// recovery.mjs; the typed app-side use is src/utils/plan.ts. Detail:
// docs/training-plan.md ("Open plans and blocks").

import { goalKind } from "./recovery.mjs";

export const OPEN_BLOCK_WEEKS = 4;
export const OPEN_TARGETS = ["faster", "further", "healthy"];

// `ratio` is the run/walk sentence ("run 2 min / walk 1 min") on a run/walk plan.
export const checkpointDesc = (km, ratio) => ratio
  ? `Checkpoint run/walk — ${km} km, ${ratio}, steady and comfortable`
  : `Checkpoint run — ${km} km, steady and comfortable. Notice how it feels compared with a month ago`;

// The coach's GOAL line for a plan with no race; "" for a race plan.
export function openGoalLine(plan) {
  if (goalKind(plan) === "race") return "";
  const g = plan.goal || {};
  const target = g.target === "faster" ? `faster at ${g.distanceKm} km`
    : g.target === "further" ? "run further" : "stay healthy and consistent";
  return `keep improving, ${target}${g.light ? ", lighter plan (about 2 easy runs a week)" : ""} `
    + "(4-week blocks ending in a checkpoint run, no race date)";
}
