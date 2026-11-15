import { isCrossTraining, type Run } from "../types";

// When the app may hand the runner to a store's own UI. Both stores forbid
// asking for a review from a button or behind an "Enjoying the app?" question,
// so the review sheet is requested only at a moment the app picks: Home, right
// after a run is saved, from someone who plainly runs with the app. docs/release.md.

export const REVIEW_MIN_RUNS = 6;
export const REVIEW_MIN_TENURE_DAYS = 14;
export const REVIEW_RECENT_DAYS = 21;
export const REVIEW_RECENT_RUNS = 3;
export const REVIEW_GAP_DAYS = 120;

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((new Date(to + "T00:00:00").getTime() - new Date(from + "T00:00:00").getTime()) / DAY_MS);

export function reviewPromptDue({ runs, asks = [], today }: { runs: Run[]; asks?: string[]; today: string }) {
  const running = runs.filter((r) => !isCrossTraining(r) && r.date <= today);
  if (running.length < REVIEW_MIN_RUNS) return false;
  const first = running.reduce((min, r) => (r.date < min ? r.date : min), today);
  if (daysBetween(first, today) < REVIEW_MIN_TENURE_DAYS) return false;
  const recent = running.filter((r) => daysBetween(r.date, today) < REVIEW_RECENT_DAYS).length;
  if (recent < REVIEW_RECENT_RUNS) return false;
  const last = asks.reduce((max, d) => (d > max ? d : max), "");
  return !last || daysBetween(last, today) >= REVIEW_GAP_DAYS;
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
