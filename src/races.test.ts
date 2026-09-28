import { describe, it, expect, vi } from "vitest";

vi.mock("./supabase", () => ({ supabase: {} }));
vi.mock("./db", () => ({ currentUserId: () => null }));
vi.mock("./notify", () => ({ notifyContribution: vi.fn() }));

const { raceUrl } = await import("./races");

describe("raceUrl", () => {
  it("keeps web links", () => {
    expect(raceUrl("https://example.org/race")).toBe("https://example.org/race");
    expect(raceUrl("http://example.org/")).toBe("http://example.org/");
  });

  it("completes a bare host, which otherwise renders as a broken relative link", () => {
    expect(raceUrl(" www.example.org/race ")).toBe("https://www.example.org/race");
  });

  it("refuses any other scheme, including the app's own deep link", () => {
    expect(raceUrl("javascript:alert(1)")).toBeNull();
    expect(raceUrl("solutions.camboulive.run://callback?code=x")).toBeNull();
    expect(raceUrl("data:text/html,<b>x</b>")).toBeNull();
  });

  it("treats empty as no link", () => {
    expect(raceUrl("")).toBeNull();
    expect(raceUrl(null)).toBeNull();
  });
});
