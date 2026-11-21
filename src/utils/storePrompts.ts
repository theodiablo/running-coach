import { isCrossTraining, type ReviewPromptState, type Run } from "../types";

// When Home may show the review card (docs/release.md, "Store prompts"). It is
// the app's own card linking to the store: the stores' native sheet can carry no
// words of ours, and both forbid opening it from a button or after a question.

export const REVIEW_MIN_RUNS = 6;
export const REVIEW_MIN_TENURE_DAYS = 14;
export const REVIEW_RECENT_DAYS = 21;
export const REVIEW_RECENT_RUNS = 3;
export const REVIEW_GAP_DAYS = 21;
export const REVIEW_MAX_ASKS = 4;

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((new Date(to + "T00:00:00").getTime() - new Date(from + "T00:00:00").getTime()) / DAY_MS);

export function reviewCardDue({ runs, state, today }: { runs: Run[]; state?: ReviewPromptState; today: string }) {
  const asks = state?.asks ?? [];
  if (state?.done || asks.length >= REVIEW_MAX_ASKS) return false;
  const running = runs.filter((r) => !isCrossTraining(r) && r.date <= today);
  if (running.length < REVIEW_MIN_RUNS) return false;
  const first = running.reduce((min, r) => (r.date < min ? r.date : min), today);
  if (daysBetween(first, today) < REVIEW_MIN_TENURE_DAYS) return false;
  const recent = running.filter((r) => daysBetween(r.date, today) < REVIEW_RECENT_DAYS).length;
  if (recent < REVIEW_RECENT_RUNS) return false;
  const last = asks.reduce((max, d) => (d > max ? d : max), "");
  return !last || daysBetween(last, today) >= REVIEW_GAP_DAYS;
}

/** A run dated today or yesterday: the runner just ran, rather than back-filling. */
export function ranRecently(date: string, now = new Date()) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const ago = daysBetween(date, today);
  return ago >= 0 && ago <= 1;
}

/** The card's ask number (1-based) for the next showing. */
export const nextReviewAsk = (state?: ReviewPromptState) => (state?.asks?.length ?? 0) + 1;

/** Records ask number `ask` as seen today; a no-op once it already is. */
export function withReviewSeen(state: ReviewPromptState | undefined, today: string, ask: number) {
  if ((state?.asks?.length ?? 0) >= ask) return state;
  return { ...state, asks: [...(state?.asks ?? []), today] };
}

// Play's flexible-update dialog: once per version, plus one reminder a week
// later. Declining is an answer; the store listing still offers the update.
export const PLAY_REMIND_DAYS = 7;
export type PlayPromptRecord = { code: number; asks: number; at: string };

export function playPromptDue(versionCode: number, rec: PlayPromptRecord | null, today: string) {
  if (!rec || rec.code !== versionCode) return true;
  return rec.asks < 2 && daysBetween(rec.at, today) >= PLAY_REMIND_DAYS;
}

export function nextPlayPromptRecord(versionCode: number, rec: PlayPromptRecord | null, today: string): PlayPromptRecord {
  return { code: versionCode, asks: rec && rec.code === versionCode ? rec.asks + 1 : 1, at: today };
}
