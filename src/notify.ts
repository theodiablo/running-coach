import { supabase } from "./supabase";

type NotifyPayload =
  | { type: "report"; reportId: string }
  | { type: "coach_feedback"; feedbackId: string }
  | { type: "beta_feedback"; feedbackId: string }
  | Record<string, unknown>;

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : err;
}

// Best-effort: ask the notify-contribution edge function to email the maintainer
// (and thank the contributor, for contribution types). Never throws and never
// blocks the UI — if the function/secret isn't deployed, the caller's DB row is
// already written and that's enough.
export function notifyContribution(payload: NotifyPayload) {
  try {
    supabase.functions.invoke("notify-contribution", { body: payload })
      .catch((err: unknown) => console.warn("notify-contribution failed (non-fatal)", errorMessage(err)));
  } catch (err) {
    console.warn("notify-contribution unavailable (non-fatal)", errorMessage(err));
  }
}
