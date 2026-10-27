import { describe, it, expect } from "vitest";
import { onboardingSteps } from "./onboarding";

const steps = onboardingSteps as (intent?: "race" | "fitness" | "live" | null) => string[];

describe("onboardingSteps", () => {
  it("returns the race branch for the race intent", () => {
    expect(onboardingSteps("race")).toEqual(
      ["welcome", "intent", "race", "raceGoal", "hr", "health", "summary"]);
  });
  it("returns the lighter training branch for the fitness intent", () => {
    expect(onboardingSteps("fitness")).toEqual(
      ["welcome", "intent", "training", "hr", "health", "summary"]);
  });
  it("returns the plan-free live branch, ending at the health gate", () => {
    expect(onboardingSteps("live")).toEqual(
      ["welcome", "intent", "liveRace", "liveLink", "health"]);
  });
  it("adds the device-readiness step to the live branch on native only", () => {
    expect(onboardingSteps("live", { native: true })).toEqual(
      ["welcome", "intent", "liveRace", "liveReady", "liveLink", "health"]);
    expect(onboardingSteps("race", { native: true })).toEqual(onboardingSteps("race"));
  });
  it("defaults to the race branch when intent is unset", () => {
    expect(steps(null)).toEqual(steps("race"));
    expect(steps(undefined)).toEqual(steps("race"));
  });
  // The [welcome, intent] shared prefix and the trailing health→summary gate are
  // both fully pinned by the two exact-sequence assertions above, so no separate
  // invariant tests for them.
});
