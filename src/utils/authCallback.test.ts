import { describe, it, expect } from "vitest";
import { classifyAuthUrl, emailChangeOutcome } from "./authCallback";
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

  // The redirect behind "I clicked the link and nothing happened": GoTrue can
  // accept a link and answer with a bare ?message= — no code, no token, no
  // session. Classified as `none` it was a silent no-op.
  it("recognises a bare GoTrue acceptance notice", () => {
    const url = "solutions.camboulive.run://auth-callback?message=Confirmation+link+accepted.+Please+proceed+to+confirm+link+sent+to+the+other+email";
    expect(classifyAuthUrl(url)).toEqual({
      kind: "notice",
      message: "Confirmation link accepted. Please proceed to confirm link sent to the other email",
    });
  });

  it("prefers a code over a message when both are present", () => {
    const url = "solutions.camboulive.run://auth-callback?code=pkce-code&message=Something";
    expect(classifyAuthUrl(url)).toEqual({ kind: "code", code: "pkce-code" });
  });

  // GoTrue's error redirect fills in the fragment as well as the query, and the
  // implicit flow uses the fragment only.
  it("reads callback params from the fragment too", () => {
    const url = "solutions.camboulive.run://auth-callback#error=access_denied&error_description=Email+link+is+invalid+or+has+expired";
    expect(classifyAuthUrl(url)).toEqual({ kind: "error", message: "Email link is invalid or has expired" });
    expect(classifyAuthUrl("solutions.camboulive.run://auth-callback#message=Accepted")).toEqual({ kind: "notice", message: "Accepted" });
  });

  it("returns none for an unrelated or malformed url", () => {
    expect(classifyAuthUrl("solutions.camboulive.run://auth-callback")).toEqual({ kind: "none" });
    expect(classifyAuthUrl("not a url")).toEqual({ kind: "none" });
  });
});

// What the user is told after opening an email-change link. The redirect can't
// answer that (see emailChangeOutcome) — the re-read account does. Every branch
// must say SOMETHING: staying mute is what made a working first confirmation
// look like a dead link.
describe("emailChangeOutcome", () => {
  const pending = { key: "app.toasts.emailChangePending", type: "ok" };
  const failed = { key: "app.toasts.emailChangeFailed", type: "err" };

  it("says still-waiting while the change is outstanding", () => {
    expect(emailChangeOutcome(null, { email: "old@x.com", new_email: "new@x.com" })).toEqual(pending);
    expect(emailChangeOutcome("new@x.com", { email: "old@x.com", new_email: "new@x.com" })).toEqual(pending);
  });

  it("reports success once a pending change is gone", () => {
    expect(emailChangeOutcome("new@x.com", { email: "new@x.com", new_email: null })).toEqual({
      key: "app.toasts.emailChangeDone", type: "ok", vars: { email: "new@x.com" },
    });
  });

  // The link is opened in the new address's inbox, often on another device,
  // where the ?code= can't be exchanged (the PKCE verifier lives on the device
  // that started the change) even though the change landed. GoTrue's complaint
  // must not override the account state.
  it("reports success even when the link came back as an error", () => {
    expect(emailChangeOutcome("new@x.com", { email: "new@x.com" }, "invalid request").key)
      .toBe("app.toasts.emailChangeDone");
  });

  it("reports a dead link only when nothing was pending either side of it", () => {
    expect(emailChangeOutcome(null, { email: "old@x.com" }, "otp_expired")).toEqual(failed);
    expect(emailChangeOutcome(null, { email: "old@x.com" })).toEqual(failed);
  });

  it("falls back to what GoTrue said when the account can't be re-read", () => {
    expect(emailChangeOutcome("new@x.com", null)).toEqual(pending);           // link accepted
    expect(emailChangeOutcome("new@x.com", null, "otp_expired")).toEqual(failed); // link rejected
  });
});
