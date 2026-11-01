// App-side re-export of the SHARED plan validator, whose source of truth is supabase/functions/_shared/coach/ (the
// deployed agent bundles it). The app runs it as a client-side check before applying a proposal; tests use buildPlan output.
// @ts-expect-error Shared Deno/Vitest ESM has no TypeScript declaration file.
import * as sharedValidation from "../../supabase/functions/_shared/coach/validation.mjs";

type ValidationExports = {
  validatePlan: (plan: unknown, opts?: unknown) => { ok: boolean; errors?: unknown[]; warnings?: unknown[] };
  formatValidation: (result: unknown) => string;
  SESSION_TYPES: readonly string[];
  PHASES: readonly string[];
  HARD_TYPES: readonly string[];
};

const validation = sharedValidation as ValidationExports;

export const { validatePlan, formatValidation, SESSION_TYPES, PHASES, HARD_TYPES } = validation;
