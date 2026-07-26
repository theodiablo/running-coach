import { describe, it, expect } from "vitest";
import { classifyAuthUrl } from "./authCallback";
import { POLAR_DEEP_LINK } from "../polarPreinit";

// The routing rules for native deep links. Order matters: Polar's ?code= is NOT
// a Supabase auth code, and an email-change link carries no ?code= at all.
describe("classifyAuthUrl", () => {
  it("routes a Polar return before the Supabase code branch", () => {
    const url = POLAR_DEEP_LINK + "?state=polar_import%3Anative%3Aabc&code=xyz";
    expect(classifyAuthUrl(url)).toEqual({ kind: "polar", code: "xyz", state: "polar_import:native:abc" });
  });

  it("routes a Polar denial (no code) as polar, not as none", () => {
    const url = POLAR_DEEP_LINK + "?state=polar_import%3Anative%3Aabc";
    expect(classifyAuthUrl(url)).toEqual({ kind: "polar", code: null, state: "polar_import:native:abc" });
  });

  it("surfaces a provider error", () => {
    const url = "solutions.camboulive.run://auth-callback?error=access_denied&error_description=User%20cancelled";
    expect(classifyAuthUrl(url)).toEqual({ kind: "error", message: "User cancelled" });
  });

  it("recognises an email-change confirmation link", () => {
    const url = "solutions.camboulive.run://auth-callback?token_hash=abc123&type=email_change";
    expect(classifyAuthUrl(url)).toEqual({ kind: "otp", tokenHash: "abc123", otpType: "email_change" });
  });

  it("ignores a token_hash of another OTP type", () => {
    const url = "solutions.camboulive.run://auth-callback?token_hash=abc123&type=recovery";
    expect(classifyAuthUrl(url)).toEqual({ kind: "none" });
  });

  it("recognises a Supabase PKCE return", () => {
    const url = "solutions.camboulive.run://auth-callback?code=pkce-code";
    expect(classifyAuthUrl(url)).toEqual({ kind: "code", code: "pkce-code" });
  });

  it("returns none for an unrelated or malformed url", () => {
    expect(classifyAuthUrl("solutions.camboulive.run://auth-callback")).toEqual({ kind: "none" });
    expect(classifyAuthUrl("not a url")).toEqual({ kind: "none" });
  });
});
