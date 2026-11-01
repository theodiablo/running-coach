// One place to turn a Supabase/GoTrue auth error into copy a user can act on. Raw strings are
// English-only developer text, and the ones that matter most concern the confirmation EMAIL:
// a user who can't tell "we already sent it" from "it failed" presses the button again.
// Returns null when nothing fits, so a caller keeps its own fallback over a vaguer message.

export type AuthErrorLike = {
  message?: string | null;
  code?: string | null;
  status?: number | null;
};

// `tone` because half of these are not failures the user caused or can fix:
// "we already sent it, wait 52s" in error red reads as "it went wrong" and
// sends them straight back to the button. Amber = nothing is broken, wait.
export type AuthMessage = {
  key: string;
  tone: "error" | "info";
  vars?: Record<string, string | number>;
};

// "For security purposes, you can only request this after 52 seconds."
const COOLDOWN_SECONDS = /after (\d+) seconds?/i;

// Takes `unknown` so a caller can hand it whatever it caught, without casting.
export function authErrorMessage(err: unknown): AuthMessage | null {
  if (!err || typeof err !== "object") return null;
  const { message: rawMessage, code: rawCode, status } = err as AuthErrorLike;
  const message = rawMessage || "";
  const code = rawCode || "";

  // The mail limiter, the only case where we may promise an email is on its way. GoTrue uses one
  // code for both the per-address cooldown and the hourly cap. The message is matched too:
  // `code` is only populated by newer GoTrue, and a code-less cooldown must fall through below.
  if (code === "over_email_send_rate_limit" || /email rate limit/i.test(message)) {
    const wait = COOLDOWN_SECONDS.exec(message);
    return wait
      ? { key: "authErrors.emailCooldown", tone: "info", vars: { seconds: wait[1] } }
      : { key: "authErrors.emailRateLimit", tone: "info" };
  }
  // Some other limiter (sign-in attempts, unspecified 429s, and older projects
  // that don't populate `code`). Say to wait without claiming an email was sent.
  if (code === "over_request_rate_limit" || status === 429 || /rate limit/i.test(message)) {
    return { key: "authErrors.tooManyRequests", tone: "info" };
  }
  // The mailer itself failed (SMTP down, provider rejected the address). GoTrue
  // reports it as a 500 `unexpected_failure` whose message names the mail it was
  // trying to send: "Error sending confirmation email".
  if (/error sending/i.test(message) || code === "email_provider_disabled") {
    return { key: "authErrors.emailSendFailed", tone: "error" };
  }
  if (code === "email_address_invalid" || (code === "validation_failed" && /email/i.test(message))) {
    return { key: "authErrors.emailInvalid", tone: "error" };
  }
  if (code === "email_exists" || code === "user_already_exists") {
    return { key: "authErrors.emailTaken", tone: "error" };
  }
  // Confirmations are on, so a brand-new account can't sign in until the link
  // is opened. GoTrue's own "Email not confirmed" doesn't say what to do.
  if (code === "email_not_confirmed") {
    return { key: "authErrors.emailNotConfirmed", tone: "error" };
  }
  return null;
}

// The one error the merged login form forks on, rather than prints. GoTrue
// answers identically for "no account with that address" and "wrong password"
// — an endpoint that told them apart would be an account-enumeration oracle —
// so the screen stops guessing and offers both ways out instead.
export function isInvalidCredentials(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { message, code } = err as AuthErrorLike;
  return code === "invalid_credentials" || /invalid login credentials/i.test(message || "");
}

// Sign-up answered "that address is taken". Also a fork, not a dead end: the
// person in front of the form is almost always the account's owner, arriving
// from a "Get started" button out of habit.
export function isEmailTaken(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { message, code } = err as AuthErrorLike;
  return code === "email_exists" || code === "user_already_exists"
    || /already registered|already been registered/i.test(message || "");
}
