import { describe, it, expect } from "vitest";
import { normalizePublicName, publicNameIssue } from "./publicName";

// Mirrors the profiles_public_name_shape constraint (migration race_field); the server
// is the authority, this only has to agree with it on what the field reports.
const cp = (...points: number[]) => String.fromCodePoint(...points);

describe("publicNameIssue", () => {
  it.each(["Zoé L.", "Alex M.", "Iñaki", "Łukasz", "Ωμέγα", "Jean-Luc", "O'Neil", "Al" + cp(0x3000) + "ex"])("accepts %s", (name) => {
    expect(publicNameIssue(name)).toBeNull();
  });

  it.each([
    ["a", "short"],
    ["x".repeat(25), "long"],
    [" Alex", "spaces"],
    ["Alex ", "spaces"],
    ["Al  ex", "spaces"],
    ["Al" + cp(0xa0), "spaces"],
    ["Al" + cp(0x202e) + "ex", "invisible"],
    ["Al" + cp(0x200b) + "ex", "invisible"],
    [cp(0x3164, 0x3164, 0x3164), "invisible"],
    ["Al" + cp(0xe0041) + "ex", "invisible"],
    ["alex.com", "link"],
    ["www.x.com", "link"],
    ["me@x", "link"],
    ["12", "letter"],
    ["..", "letter"],
  ])("rejects %j as %s", (name, issue) => {
    expect(publicNameIssue(name)).toBe(issue);
  });

  it("counts characters, not UTF-16 units", () => {
    expect(publicNameIssue(cp(0x1d400).repeat(24) + "a")).toBe("long");
    expect(publicNameIssue("é".repeat(24))).toBeNull();
  });
});

describe("normalizePublicName", () => {
  it("trims and collapses what a person typed", () => {
    expect(normalizePublicName("  Alex   M. ")).toBe("Alex M.");
    expect(normalizePublicName("Al" + cp(0xa0, 0xa0) + "ex")).toBe("Al ex");
  });
});
