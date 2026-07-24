import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted so the module-level supabase mock can reach it.
const h = vi.hoisted(() => ({ maybeSingle: vi.fn() }));

vi.mock("./supabase", () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: h.maybeSingle }) }) }),
  },
}));

const { isPremiumActive, fetchPremiumUntil } = await import("./premium");

describe("isPremiumActive", () => {
  const now = Date.parse("2026-07-24T12:00:00Z");

  it("treats a missing entitlement as free", () => {
    expect(isPremiumActive(null, now)).toBe(false);
    expect(isPremiumActive(undefined, now)).toBe(false);
    expect(isPremiumActive("", now)).toBe(false);
  });

  it("is premium while premium_until is in the future", () => {
    expect(isPremiumActive("2026-08-24T12:00:00+00:00", now)).toBe(true);
    expect(isPremiumActive("2099-01-01T00:00:00+00:00", now)).toBe(true);
  });

  it("is free once premium_until has passed", () => {
    expect(isPremiumActive("2026-07-24T11:59:59+00:00", now)).toBe(false);
    expect(isPremiumActive("2025-01-01T00:00:00+00:00", now)).toBe(false);
  });

  it("treats exactly-now as expired", () => {
    expect(isPremiumActive("2026-07-24T12:00:00.000Z", now)).toBe(false);
  });

  // Postgres accepts timestamptz 'infinity' and PostgREST serialises it as this
  // literal, which Date.parse reports as NaN. The migration bans it; this pins
  // the behaviour so a stray grant can't read as premium on one end and free on
  // the other (the edge functions apply the same NaN rule).
  it("treats unparseable values, including 'infinity', as free", () => {
    expect(isPremiumActive("infinity", now)).toBe(false);
    expect(isPremiumActive("not a date", now)).toBe(false);
  });

  it("compares against the real clock by default", () => {
    expect(isPremiumActive(new Date(Date.now() + 60_000).toISOString())).toBe(true);
    expect(isPremiumActive(new Date(Date.now() - 60_000).toISOString())).toBe(false);
  });
});

describe("fetchPremiumUntil", () => {
  // Block body on purpose: mockReset() returns the mock, and Vitest treats a
  // function returned from a hook as a teardown callback — it would CALL the
  // mock after each test, throwing whatever implementation the test installed.
  beforeEach(() => { h.maybeSingle.mockReset(); });

  it("returns the stored timestamp", async () => {
    h.maybeSingle.mockResolvedValue({ data: { premium_until: "2026-08-24T12:00:00+00:00" }, error: null });
    await expect(fetchPremiumUntil("u1")).resolves.toBe("2026-08-24T12:00:00+00:00");
  });

  it("returns null (free) for a row with no entitlement", async () => {
    h.maybeSingle.mockResolvedValue({ data: { premium_until: null }, error: null });
    await expect(fetchPremiumUntil("u1")).resolves.toBeNull();
  });

  it("returns null (free) when there is no profile row", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(fetchPremiumUntil("u1")).resolves.toBeNull();
  });

  // The app must render offline / on RLS or transport failure, so every failure
  // degrades to the free tier instead of throwing. The server is the real gate.
  it("never throws on a query error", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    await expect(fetchPremiumUntil("u1")).resolves.toBeNull();
  });

  it("never throws when the request rejects", async () => {
    h.maybeSingle.mockRejectedValue(new Error("offline"));
    await expect(fetchPremiumUntil("u1")).resolves.toBeNull();
  });
});
