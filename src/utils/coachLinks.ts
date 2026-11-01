// In-app destinations the coach may link to. The model writes an `app:` link
// (`[your goal](app:goal)`) and the runner gets a button to that screen; the coach can
// never change the goal itself, only ask. This list IS the allowlist: CoachText renders an
// `app:` link only if its target is here, so an invented one degrades to plain text.
export type CoachLinkTarget = "goal" | "log" | "training" | "integrations" | "history" | "next";

export const COACH_LINK_TARGETS: readonly CoachLinkTarget[] =
  ["goal", "log", "training", "integrations", "history", "next"] as const;

const PREFIX = "app:";

export const isCoachLinkTarget = (v: string): v is CoachLinkTarget =>
  (COACH_LINK_TARGETS as readonly string[]).includes(v);

// Returns the target for an `app:` href, or null for anything else — an
// external URL, an unknown destination, or a malformed href.
export function coachLinkTarget(href: string | undefined): CoachLinkTarget | null {
  if (!href) return null;
  const raw = href.trim();
  if (!raw.toLowerCase().startsWith(PREFIX)) return null;
  const target = raw.slice(PREFIX.length).trim().toLowerCase();
  return isCoachLinkTarget(target) ? target : null;
}
