// Onboarding flow shape, pure so branch sequencing is unit-testable. Branches on `intent`:
// race (picker + goal), getting started (training-only), live-follow (no plan: race,
// device readiness, share link). All branches share an
// identical [welcome, intent] prefix and the health gate; plan branches end on a summary.
import type { HealthAck, HrMethod, Intent, SettingsState } from "../types";

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

export type OnboardingResult = {
  name: string;
  plan: Partial<SettingsState> | null;
  hr: Partial<SettingsState> | null;
  hrMethod: HrMethod | null;
  healthAck: NonNullable<HealthAck>;
  live: { editionId: string | null; linkSent: boolean } | null;
};

// The settings a finished onboarding commits. `plan` carries the race-shaped
// fields incl. targetEditionId; the scaffolding (onboardStep/intent) is cleared;
// the one-time signposts are seeded `false` so they only reach accounts that
// onboard from this version on (see the SettingsState comment).
export function onboardedSettings(settings: SettingsState, { name, plan, hr, hrMethod, healthAck, live }: OnboardingResult): SettingsState {
  return {...settings, name, onboarded: true, onboardStep: 0, intent: null, healthAck,
    coachIntroSeen: false, coachOverdueIntroSeen: false, feedbackIntroSeen: false, ...plan, ...(hr || {}),
    ...(hrMethod ? {hrMethod} : {}),
    // The live branch's race is a participation, never the plan target, and
    // race fields left by a plan branch the runner backed out of are dropped.
    ...(live ? {liveFirst: true, liveLinkSent: live.linkSent, raceBridgeSeen: false, targetEditionId: null,
      raceDate: "", distanceKm: "", goalSec: "", raceElevation: 0, goalKind: "race" as const} : {})};
}

// buildPlan needs a date and a distance (a plan branch may have skipped straight
// to the gate), and the live branch never builds one. A block plan (the fitness
// branch) has no date, only the distance its blocks build towards.
export const onboardingBuildsPlan = (next: SettingsState, live: boolean) =>
  !live && !!next.distanceKm && (next.goalKind === "block" || !!next.raceDate);
