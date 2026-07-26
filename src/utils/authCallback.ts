import { POLAR_DEEP_LINK } from "../polarPreinit";

// Pure classification of a native deep-link URL (appUrlOpen / getLaunchUrl) so
// App.tsx's handler is a plain switch and the routing rules are unit-testable
// without mounting App. Order encodes priority:
//   1. Polar OAuth return — its ?code= is NOT a Supabase auth code and must
//      never reach exchangeCodeForSession (see polarPreinit.ts).
//   2. Provider error (user cancelled the consent screen) — surface it.
//   3. Email OTP confirmation (?token_hash=&type=email_change) — sent when the
//      email template is customised to use {{ .TokenHash }}; Supabase's PKCE
//      ?code= path does not cover those links, they need verifyOtp.
//   4. GoTrue notice (?message=) — /auth/v1/verify accepted a link but has
//      nothing to hand back (no code, no token, no session). Unclassified, that
//      tap is a silent no-op that reads as "the link did nothing".
//   5. Supabase PKCE ?code= — OAuth sign-in return, and the email-change
//      confirmation (which does issue a session).
export type AuthCallback =
  | { kind: "polar"; code: string | null; state: string | null }
  | { kind: "error"; message: string }
  | { kind: "otp"; tokenHash: string; otpType: "email_change" }
  | { kind: "notice"; message: string }
  | { kind: "code"; code: string }
  | { kind: "none" };

// GoTrue puts its post-verify params in the query for the PKCE flow and in the
// fragment for the implicit one — and its error redirect fills in BOTH. Read
// the two so a template or flow-type change can't turn a handled callback back
// into a silent no-op. Query wins on a conflict (it's what our PKCE client gets).
function callbackParams(url: string): URLSearchParams | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const params = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  parsed.searchParams.forEach((v, k) => params.set(k, v));
  return params;
}

export function classifyAuthUrl(url: string): AuthCallback {
  if (url.startsWith(POLAR_DEEP_LINK)) {
    try {
      const p = new URL(url).searchParams;
      return { kind: "polar", code: p.get("code"), state: p.get("state") };
    } catch {
      return { kind: "polar", code: null, state: null };
    }
  }
  const params = callbackParams(url);
  if (!params) return { kind: "none" };
  const provErr = params.get("error_description") || params.get("error");
  if (provErr) return { kind: "error", message: provErr };
  const tokenHash = params.get("token_hash");
  if (tokenHash && params.get("type") === "email_change") {
    return { kind: "otp", tokenHash, otpType: "email_change" };
  }
  const code = params.get("code");
  if (code) return { kind: "code", code };
  const message = params.get("message");
  if (message) return { kind: "notice", message };
  return { kind: "none" };
}

// What to tell the user after they open an email-change confirmation link. The
// redirect can't answer that — the link is opened in the new address's inbox,
// often on another device, where the ?code= is unexchangeable even though the
// change landed. Decided instead from the re-read account (`user`, null when the
// server was unreachable) against `pendingBefore`: user.new_email as it was
// BEFORE the link was opened, the only thing separating "the change just
// completed" from "that link was never valid".
export type AuthNoticeSpec = { key: string; type: "ok" | "err"; vars?: Record<string, string> };

export function emailChangeOutcome(
  pendingBefore: string | null,
  user: { email?: string | null; new_email?: string | null } | null,
  failure?: string,
): AuthNoticeSpec {
  // Couldn't re-read the account: repeat only what GoTrue itself just said —
  // it either accepted the link or rejected it. Never guess past that.
  if (!user) {
    return failure
      ? { key: "app.toasts.emailChangeFailed", type: "err" }
      : { key: "app.toasts.emailChangePending", type: "ok" };
  }
  if (user.new_email) return { key: "app.toasts.emailChangePending", type: "ok" };
  // Something was pending and now isn't — it went through, whatever the
  // redirect said on the way back.
  if (pendingBefore) {
    return { key: "app.toasts.emailChangeDone", type: "ok", vars: { email: user.email || pendingBefore } };
  }
  // Nothing pending before, nothing pending now: the link bought us nothing
  // (expired, or already used — opening the same one twice).
  return { key: "app.toasts.emailChangeFailed", type: "err" };
}
