import { describe, expect, it } from "vitest";
import { climbLooksHigh, raceDateBounds, raceDateInBounds, raceUrl, tidyName } from "./raceForm";

describe("raceUrl repairs", () => {
  it.each([
    ["https://https//:Kilimanjarointernationalmarathon.com", "https://kilimanjarointernationalmarathon.com/"],
    ["https//www.example.fr", "https://www.example.fr/"],
    ["http:/www.example.fr/x", "https://www.example.fr/x"],
    ["HTTPS://Example.FR/Race", "https://example.fr/Race"],
    ["example.org:8080/x", "https://example.org:8080/x"],
    ["https://münchen-marathon.de", "https://xn--mnchen-marathon-zvb.de/"],
  ])("%s → %s", (input, out) => expect(raceUrl(input)).toBe(out));

  it("keeps an explicit http link as http", () => {
    expect(raceUrl("http://example.org/")).toBe("http://example.org/");
  });

  it.each(["hackney half", "localhost", "https://192.168.0.1", "foo", "https://user:pw@example.com", "mailto:a@b.co", "https://https://javascript:alert(1)"])(
    "refuses %s", input => expect(raceUrl(input)).toBeNull());
});

describe("raceDateBounds", () => {
  it("runs from a year back to two years ahead", () => {
    expect(raceDateBounds("2026-11-28")).toEqual({ min: "2025-11-28", max: "2028-11-28" });
    expect(raceDateInBounds("2028-11-28", "2026-11-28")).toBe(true);
    expect(raceDateInBounds("2028-11-29", "2026-11-28")).toBe(false);
    expect(raceDateInBounds("2025-11-27", "2026-11-28")).toBe(false);
  });
});

describe("climbLooksHigh", () => {
  it("flags an altitude typed as a road race's gain, not a mountain trail", () => {
    expect(climbLooksHigh(42.2, 1500, "road")).toBe(true);
    expect(climbLooksHigh(42.2, 500, "road")).toBe(false);
    expect(climbLooksHigh(42.2, 1500, "trail")).toBe(false);
    expect(climbLooksHigh(10, 2000, "trail")).toBe(true);
    expect(climbLooksHigh(0, 100, "road")).toBe(false);
  });
});

it("tidyName trims and collapses spaces", () => {
  expect(tidyName("  Lyon   Marathon ")).toBe("Lyon Marathon");
});
