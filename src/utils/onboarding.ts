// Onboarding flow shape. Kept pure (no React) so the branch sequencing — the
// riskiest part of the wizard — is unit-testable and lives outside the component.
//
// The wizard branches on the user's `intent`: a race-targeting user gets a race
// picker + goal step, a "just getting started" user gets a lighter training-only
// step, and a "let people follow my race" user gets no plan at all, only what
// race day needs (race, device readiness, the share link). All branches share an
// identical [welcome, intent] prefix so a refresh before intent is chosen resolves
// the same regardless of branch, and all pass the mandatory health gate. The plan
// branches end on an (in-memory only) summary; the live one completes at the gate.
import type { Intent } from "../types";

export type OnboardingStep =
  | "welcome" | "intent" | "race" | "raceGoal" | "training" | "hr" | "health" | "summary"
  | "liveRace" | "liveReady" | "liveLink";

// `native`: the readiness step checks OS permissions, which a browser doesn't have.
export function onboardingSteps(intent: Intent | string | undefined, { native = false }: { native?: boolean } = {}): OnboardingStep[] {
  if (intent === "live") return ["welcome", "intent", "liveRace", ...(native ? ["liveReady" as const] : []), "liveLink", "health"];
  const tail: OnboardingStep[] = ["hr", "health", "summary"];
  if (intent === "fitness") return ["welcome", "intent", "training", ...tail];
  // Default (intent unset or "race") — the race branch.
  return ["welcome", "intent", "race", "raceGoal", ...tail];
}
