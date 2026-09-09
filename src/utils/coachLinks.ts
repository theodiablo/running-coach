// In-app destinations the coach may link to. The model writes an `app:` link
// (`[your goal](app:goal)`) and the runner gets a button that lands on the
// right screen — the alternative it kept reaching for was prose ("adjust it in
// the plan settings"), a dead end in the one place the coach architecturally
// cannot act: it can never change the goal itself, only ask for it.
//
// This list IS the allowlist. CoachText renders an `app:` link only when its
// target is here, so an invented destination degrades to plain text rather than
// a button that goes nowhere — the same posture as the external-URL strip.
export type CoachLinkTarget = "goal" | "log" | "training" | "integrations" | "history";

export const COACH_LINK_TARGETS: readonly CoachLinkTarget[] =
  ["goal", "log", "training", "integrations", "history"] as const;

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
