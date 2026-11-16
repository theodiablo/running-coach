import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry", () => ({ track }));

import { AuthRetryableFetchError } from "@supabase/supabase-js";
import { authFailureCode, oauthClosedByUser, oauthOpened, oauthPageLoaded, settleOAuth, trackAuthFailed } from "./authTelemetry";

beforeEach(() => {
  track.mockClear();
  settleOAuth();
});
afterEach(() => vi.useRealTimers());

describe("authFailureCode", () => {
  it("keeps GoTrue's own code", () => {
    expect(authFailureCode({ code: "invalid_credentials", status: 400, message: "Invalid login credentials" })).toBe("invalid_credentials");
  });

  it("tells a request that never got an answer from one that timed out", () => {
    expect(authFailureCode(new AuthRetryableFetchError("Load failed", 0))).toBe("network");
    expect(authFailureCode(new AuthRetryableFetchError("Request timed out", 0))).toBe("timeout");
    expect(authFailureCode(new TypeError("Load failed"))).toBe("network");
  });

  it("falls back to the HTTP status, then to unknown", () => {
    expect(authFailureCode({ status: 502, message: "Bad gateway" })).toBe("http_502");
    expect(authFailureCode(new Error("boom"))).toBe("unknown");
    expect(authFailureCode(null)).toBe("unknown");
  });

  it("never lets free text through as a code", () => {
    expect(authFailureCode({ code: "runner@example.com" })).toBe("unknown");
    expect(authFailureCode("User cancelled the login")).toBe("unknown");
    expect(authFailureCode("access_denied")).toBe("access_denied");
  });

  it("sends only the method, the stage and the code", () => {
    trackAuthFailed("password", "request", { code: "invalid_credentials", message: "Invalid login credentials for runner@example.com" });
    expect(track).toHaveBeenCalledWith("auth_failed", { method: "password", stage: "request", code: "invalid_credentials" });
  });
});

describe("the in-app browser round trip", () => {
  it("reports a sheet the user closed, with how far it got", () => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    oauthOpened("google", cleanup);
    oauthPageLoaded();
    vi.advanceTimersByTime(42_400);
    oauthClosedByUser();
    expect(track).toHaveBeenCalledWith("auth_cancelled", { method: "google", loaded: true, secs: 42 });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("hands the provider to the callback, which then owns the outcome", () => {
    const cleanup = vi.fn();
    oauthOpened("apple", cleanup);
    expect(settleOAuth()).toBe("apple");
    expect(cleanup).toHaveBeenCalledOnce();
    oauthClosedByUser();
    expect(track).not.toHaveBeenCalled();
  });

  it("forgets a tap abandoned long before the callback", () => {
    vi.useFakeTimers();
    oauthOpened("google");
    vi.advanceTimersByTime(11 * 60_000);
    expect(settleOAuth()).toBe("deeplink");
  });

  it("names a callback nobody started here a deep link", () => {
    expect(settleOAuth()).toBe("deeplink");
  });

  it("drops the previous sheet's listeners when a second one opens", () => {
    const first = vi.fn();
    oauthOpened("google", first);
    oauthOpened("google");
    expect(first).toHaveBeenCalledOnce();
  });
});
