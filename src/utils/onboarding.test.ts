import { describe, it, expect } from "vitest";
import { onboardedSettings, onboardingBuildsPlan, onboardingSteps } from "./onboarding";
import type { SettingsState } from "../types";

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

describe("onboardedSettings", () => {
  const ack = { v: 1, at: "2026-10-27T00:00:00Z" };
  // What a plan branch persists on its way, before the runner backs out of it.
  const stale = { raceDate: "2027-04-12", distanceKm: 42.195, goalSec: 12600, raceElevation: 120, targetEditionId: "paris-2027-04-12" } as unknown as SettingsState;

  it("drops race fields a backed-out plan branch left behind, and builds no plan", () => {
    const next = onboardedSettings(stale, { name: "", plan: null, hr: null, hrMethod: null, healthAck: ack,
      live: { editionId: "x", linkSent: true } });
    expect(next).toMatchObject({ raceDate: "", distanceKm: "", goalSec: "", raceElevation: 0, targetEditionId: null,
      liveFirst: true, liveLinkSent: true, raceBridgeSeen: false, onboarded: true, intent: null });
    expect(onboardingBuildsPlan(next, true)).toBe(false);
    expect(onboardingBuildsPlan({ ...next, raceDate: "2027-04-12", distanceKm: 42.195 }, true)).toBe(false);
  });

  it("keeps a plan branch's race and builds its plan", () => {
    const next = onboardedSettings({} as SettingsState, { name: "Léa", plan: stale, hr: null, hrMethod: null, healthAck: ack, live: null });
    expect(next).toMatchObject({ raceDate: "2027-04-12", targetEditionId: "paris-2027-04-12", name: "Léa" });
    expect(next.liveFirst).toBeUndefined();
    expect(onboardingBuildsPlan(next, false)).toBe(true);
    expect(onboardingBuildsPlan({ ...next, raceDate: "" }, false)).toBe(false);
  });
});
