// Typed app-side re-export of the open-plan constants and the checkpoint
// sentence, which live with the edge function so the coach's tools write the
// same one (supabase/functions/_shared/coach/open.mjs).
// @ts-expect-error Shared Deno/Vitest ESM has no TypeScript declaration file.
import * as sharedOpen from "../../supabase/functions/_shared/coach/open.mjs";
import type { OpenTarget, Plan } from "../types";

type OpenExports = {
  OPEN_BLOCK_WEEKS: number;
  OPEN_TARGETS: OpenTarget[];
  checkpointDesc: (km: number, ratio?: string) => string;
  openGoalLine: (plan: Plan) => string;
};

export const { OPEN_BLOCK_WEEKS, OPEN_TARGETS, checkpointDesc, openGoalLine } = sharedOpen as OpenExports;
