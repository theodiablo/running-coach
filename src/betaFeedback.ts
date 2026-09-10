import { supabase } from "./supabase";
import { currentUserId } from "./db";
import { notifyContribution } from "./notify";
import { platform, nativeBuildLabel } from "./native";

// Where the user was when they tapped the button. The four tabs, plus the two
// surfaces that carry their own entry point because a floating pill can't sit
// on them (the coach's send button is already bottom-right, and a badge over
// the settings list reads as an ad).
export type FeedbackSource =
  | "dash" | "plan" | "races" | "progress" | "log" | "coach" | "settings";

// `tab` is a bare string on the state hub and takes values the sheet has no
// name for. Map rather than cast: an unmapped tab reaches the UI as the raw
// i18n key ("feedback.source.log") and lands in the stored row, where it
// quietly pollutes the column the reports are grouped by.
const TAB_SOURCES = new Set<string>(["dash", "plan", "races", "progress", "log"]);
export function feedbackSourceForTab(tab: string): FeedbackSource {
  return TAB_SOURCES.has(tab) ? tab as FeedbackSource : "dash";
}

export type FeedbackInputMode = "text" | "voice";

export const MAX_FEEDBACK_LEN = 4000;

// Send beta feedback. Inserts WITHOUT a returning .select() — beta_feedback has
// no client SELECT policy, so reading back the row would 403 even though the
// write succeeds (mirrors submitCoachFeedback in src/coachFeedback.ts).
export async function submitBetaFeedback(
  { body, source, inputMode }: { body: string; source: FeedbackSource; inputMode: FeedbackInputMode },
) {
  const user_id = currentUserId();
  if (!user_id) throw new Error("Not signed in");
  const text = body.trim();
  if (!text) throw new Error("Empty feedback");
  const id = crypto.randomUUID();
  const { error } = await supabase.from("beta_feedback").insert({
    id, user_id, body: text.slice(0, MAX_FEEDBACK_LEN),
    source, platform, app_version: nativeBuildLabel() || null, input_mode: inputMode,
  });
  if (error) throw error;
  notifyContribution({ type: "beta_feedback", feedbackId: id });
}
