import { CLOUD_OAUTH, cloudOauthProviderIds, type CloudOauthProviderId } from "../cloudOauthPreinit";

// Pure classification of a native deep-link URL so App.tsx's handler is a plain switch. Priority: cloud-provider OAuth return
// (its ?code= is NOT a Supabase code, never exchangeCodeForSession), provider error, password recovery, email-change OTP
// (?token_hash=&type=, needs verifyOtp), bare ?message= notice, then PKCE ?code=. See CLAUDE.md "Auth callbacks".
// Recovery outranks `code`: GoTrue's stock link can land as ?code=&type=recovery, which exchanged as a sign-in leaves no way to set a password.
export type RecoveryTokens = { accessToken: string; refreshToken: string };

export type AuthCallback =
  | { kind: "cloudOauth"; provider: CloudOauthProviderId; code: string | null; state: string | null }
  | { kind: "error"; message: string }
  // Our own template sends a token_hash to verify; GoTrue's stock one can
  // arrive as a code to exchange, or (implicit /verify, e.g. a dashboard-sent
  // reset) as a session in the fragment that our PKCE client refuses to adopt.
  // All may be null: a link with nothing to redeem.
  | { kind: "recovery"; tokenHash: string | null; code: string | null; tokens: RecoveryTokens | null }
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
  for (const provider of cloudOauthProviderIds) {
    if (!url.startsWith(CLOUD_OAUTH[provider].deepLink)) continue;
    try {
      const p = new URL(url).searchParams;
      return { kind: "cloudOauth", provider, code: p.get("code"), state: p.get("state") };
    } catch {
      return { kind: "cloudOauth", provider, code: null, state: null };
    }
  }
  const params = callbackParams(url);
  if (!params) return { kind: "none" };
  const provErr = params.get("error_description") || params.get("error");
  if (provErr) return { kind: "error", message: provErr };
  const tokenHash = params.get("token_hash");
  if (params.get("type") === "recovery") {
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    const tokens = accessToken && refreshToken ? { accessToken, refreshToken } : null;
    return { kind: "recovery", tokenHash, code: params.get("code"), tokens };
  }
  if (tokenHash && params.get("type") === "email_change") {
    return { kind: "otp", tokenHash, otpType: "email_change" };
  }
  const code = params.get("code");
  if (code) return { kind: "code", code };
  const message = params.get("message");
  if (message) return { kind: "notice", message };
  return { kind: "none" };
}

// What to tell the user after an email-change confirmation link. The redirect can't answer (it opens in the new inbox,
// often on another device, where ?code= is unexchangeable though the change landed), so decide from the re-read account
// (`user`, null when unreachable) against `pendingBefore` (user.new_email before the link): the only thing separating
// "the change just completed" from "that link was never valid".
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
