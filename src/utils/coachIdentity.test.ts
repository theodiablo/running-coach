import { describe, it, expect } from "vitest";
import { coachDisplayName, COACH_NAME_MAX } from "./coachIdentity";

describe("coachDisplayName", () => {
  it("trims and returns a clean name", () => {
    expect(coachDisplayName("  Ava  ")).toBe("Ava");
  });

  it("caps at COACH_NAME_MAX, without a trailing space", () => {
    const long = "A".repeat(COACH_NAME_MAX + 10);
    expect(coachDisplayName(long)).toBe("A".repeat(COACH_NAME_MAX));
    expect(coachDisplayName("A".repeat(COACH_NAME_MAX - 1) + " B")).toBe("A".repeat(COACH_NAME_MAX - 1));
  });

  it("returns null for empty, whitespace, and non-strings", () => {
    expect(coachDisplayName("")).toBeNull();
    expect(coachDisplayName("   ")).toBeNull();
    expect(coachDisplayName(undefined)).toBeNull();
    expect(coachDisplayName(null)).toBeNull();
    expect(coachDisplayName(42)).toBeNull();
    expect(coachDisplayName({})).toBeNull();
  });
});
