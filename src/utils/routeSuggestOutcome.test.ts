// Outcome mapping for the route-suggest edge-function reply. Kept in its own
// file because it mocks ../supabase and ../constants, while routeSuggest.test.ts
// covers the pure geometry helpers with no mocks at all.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("../supabase", () => ({ supabase: { functions: { invoke: h.invoke } } }));
// The capability gate short-circuits routeSuggest() before any call; force it on
// so these tests exercise the reply mapping rather than the missing map key.
vi.mock("../constants", () => ({ routeSuggestEnabled: true }));

const { routeSuggest } = await import("./routeSuggest");

const params = { lat: 45.75, lng: 4.85, km: 5 };

describe("routeSuggest outcome mapping", () => {
  // Block body on purpose: mockReset() returns the mock, and Vitest treats a
  // function returned from a hook as a teardown callback — it would CALL the
  // mock after each test, throwing whatever implementation the test installed.
  beforeEach(() => { h.invoke.mockReset(); });

  it("maps PREMIUM_REQUIRED to its own status", async () => {
    h.invoke.mockResolvedValue({ data: { error: "premium feature", code: "PREMIUM_REQUIRED" }, error: null });
    await expect(routeSuggest(params)).resolves.toEqual({ status: "premiumRequired" });
  });

  // The coded replies also carry an `error` string, so the code checks must come
  // BEFORE the generic error branch or both collapse into "couldn't fetch".
  it("prefers the code over the coexisting error field", async () => {
    h.invoke.mockResolvedValue({ data: { error: "daily route limit reached", code: "RATE_LIMIT" }, error: null });
    await expect(routeSuggest(params)).resolves.toEqual({ status: "rateLimited" });
  });

  it("maps an unconfigured backend to a plain error", async () => {
    h.invoke.mockResolvedValue({ data: { configured: false }, error: null });
    await expect(routeSuggest(params)).resolves.toEqual({ status: "error" });
  });

  it("maps a transport failure to a plain error", async () => {
    h.invoke.mockResolvedValue({ data: null, error: new Error("network") });
    await expect(routeSuggest(params)).resolves.toEqual({ status: "error" });
  });

  it("reports a successful-but-empty generation as empty", async () => {
    h.invoke.mockResolvedValue({ data: { configured: true, features: [] }, error: null });
    await expect(routeSuggest(params)).resolves.toEqual({ status: "empty" });
  });

  it("never throws when invoke rejects", async () => {
    h.invoke.mockRejectedValue(new Error("boom"));
    await expect(routeSuggest(params)).resolves.toEqual({ status: "error" });
  });
});
