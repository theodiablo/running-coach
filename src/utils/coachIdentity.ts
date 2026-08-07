// Mark ids must match COACH_MARKS in components/CoachAvatar.tsx (kept there so
// that file exports only a component; drift is caught by CoachAvatar.test.tsx).
export const COACH_MARK_IDS = ["pulse", "ridge", "track", "chevrons", "stopwatch", "flag"];
export const DEFAULT_COACH_MARK = "pulse";

export const COACH_NAME_MAX = 20;

// Trimmed and capped; ""/whitespace/non-string → null (null = localized
// generic "Coach"). Guards stale or overlong values from the synced blob.
export function coachDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().slice(0, COACH_NAME_MAX).trim();
  return name || null;
}
