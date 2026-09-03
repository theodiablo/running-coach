import { describe, it, expect } from "vitest";
import { coachLinkTarget, isCoachLinkTarget, COACH_LINK_TARGETS } from "./coachLinks";

describe("coachLinkTarget", () => {
  it("accepts every documented target", () => {
    for (const t of COACH_LINK_TARGETS) expect(coachLinkTarget(`app:${t}`)).toBe(t);
  });

  it("is tolerant of case and surrounding space", () => {
    expect(coachLinkTarget(" APP:Goal ")).toBe("goal");
  });

  // The allowlist is the whole point: an invented destination must degrade to
  // text, never to a button that goes nowhere.
  it("rejects anything not on the list", () => {
    for (const href of ["app:admin", "app:", "app:goal2", "app: goal x"]) {
      expect(coachLinkTarget(href)).toBeNull();
    }
  });

  it("rejects external URLs and other schemes", () => {
    for (const href of ["https://example.com", "http://app:goal", "mailto:a@b.com",
                        "javascript:alert(1)", "//app:goal", "capp:goal"]) {
      expect(coachLinkTarget(href)).toBeNull();
    }
  });

  it("rejects a missing href", () => {
    expect(coachLinkTarget(undefined)).toBeNull();
    expect(coachLinkTarget("")).toBeNull();
  });

  it("isCoachLinkTarget narrows to the list", () => {
    expect(isCoachLinkTarget("goal")).toBe(true);
    expect(isCoachLinkTarget("admin")).toBe(false);
  });
});
