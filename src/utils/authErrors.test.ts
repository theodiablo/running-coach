import { describe, expect, it } from "vitest";
import { authErrorMessage } from "./authErrors";
import en from "../i18n/locales/en";

// The shapes below are the ones a real sign-up produced: one 200, then six
// 429s in ninety seconds as the user pressed Create account again and again,
// each answered with a developer-facing string the app printed verbatim.

describe("authErrorMessage", () => {
  it("names the wait when the mailer is on cooldown", () => {
    expect(authErrorMessage({
      code: "over_email_send_rate_limit",
      status: 429,
      message: "For security purposes, you can only request this after 52 seconds.",
    })).toEqual({ key: "authErrors.emailCooldown", tone: "info", vars: { seconds: "52" } });
  });

  it("reads a one-second cooldown the same way", () => {
    expect(authErrorMessage({
      code: "over_email_send_rate_limit",
      status: 429,
      message: "For security purposes, you can only request this after 1 second.",
    })).toEqual({ key: "authErrors.emailCooldown", tone: "info", vars: { seconds: "1" } });
  });

  it("falls to the hourly cap when no wait is named", () => {
    expect(authErrorMessage({
      code: "over_email_send_rate_limit",
      status: 429,
      message: "email rate limit exceeded",
    })).toEqual({ key: "authErrors.emailRateLimit", tone: "info" });
  });

  it("still recognises the mailer when the server sends no code", () => {
    // `code` is only populated by newer GoTrue versions; this message names the
    // limiter on its own.
    expect(authErrorMessage({ status: 429, message: "email rate limit exceeded" }))
      .toEqual({ key: "authErrors.emailRateLimit", tone: "info" });
  });

  it("does not promise an email for a limiter that isn't the mailer", () => {
    // Claiming "we just sent you an email" here would be a lie the user then
    // waits on.
    expect(authErrorMessage({ code: "over_request_rate_limit", status: 429, message: "Request rate limit reached" }))
      .toEqual({ key: "authErrors.tooManyRequests", tone: "info" });
    expect(authErrorMessage({ status: 429, message: "Too many requests" }))
      .toEqual({ key: "authErrors.tooManyRequests", tone: "info" });
  });

  it("separates a mailer that failed from one that refused", () => {
    expect(authErrorMessage({ code: "unexpected_failure", status: 500, message: "Error sending confirmation email" }))
      .toEqual({ key: "authErrors.emailSendFailed", tone: "error" });
    expect(authErrorMessage({ code: "email_provider_disabled", status: 422, message: "Email logins are disabled" }))
      .toEqual({ key: "authErrors.emailSendFailed", tone: "error" });
  });

  it("maps a bad address and an address already in use", () => {
    expect(authErrorMessage({ code: "email_address_invalid", status: 400, message: "Email address is invalid" }))
      .toEqual({ key: "authErrors.emailInvalid", tone: "error" });
    expect(authErrorMessage({ code: "validation_failed", status: 400, message: "Unable to validate email address" }))
      .toEqual({ key: "authErrors.emailInvalid", tone: "error" });
    expect(authErrorMessage({ code: "email_exists", status: 422, message: "Email address already registered" }))
      .toEqual({ key: "authErrors.emailTaken", tone: "error" });
  });

  it("leaves an unrelated failure to the caller's own fallback", () => {
    // A wrong password says something useful already; replacing it with generic
    // copy would be a downgrade.
    expect(authErrorMessage({ code: "invalid_credentials", status: 400, message: "Invalid login credentials" })).toBeNull();
    // `validation_failed` covers more than the address, so only the email
    // variant is claimed.
    expect(authErrorMessage({ code: "validation_failed", status: 400, message: "Password is required" })).toBeNull();
    expect(authErrorMessage(null)).toBeNull();
    expect(authErrorMessage("boom")).toBeNull();
    expect(authErrorMessage({})).toBeNull();
  });

  it("only ever names keys that exist", () => {
    const dict = en as unknown as Record<string, Record<string, string>>;
    const errors = [
      { code: "over_email_send_rate_limit", message: "you can only request this after 9 seconds." },
      { code: "over_email_send_rate_limit", message: "email rate limit exceeded" },
      { code: "over_request_rate_limit", message: "" },
      { code: "unexpected_failure", message: "Error sending confirmation email" },
      { code: "email_address_invalid", message: "" },
      { code: "email_exists", message: "" },
    ];
    for (const err of errors) {
      const mapped = authErrorMessage(err);
      expect(mapped, err.code).not.toBeNull();
      const [ns, key] = mapped!.key.split(".");
      expect(dict[ns]?.[key], mapped!.key).toBeTypeOf("string");
    }
  });
});
