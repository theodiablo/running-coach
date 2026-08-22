// One place to turn a Supabase/GoTrue auth error into copy a user can act on.
//
// The raw strings are English-only and written for developers ("For security
// purposes, you can only request this after 52 seconds."), and the ones that
// matter most are about the confirmation EMAIL rather than the credentials: a
// user who can't tell "we already sent it" from "it failed" just presses the
// button again. One real sign-up produced six 429s in ninety seconds that way
// before the user gave up and used Google instead.
//
// Returns null when nothing here fits, so a caller keeps whatever fallback it
// already had rather than trading a specific server message for a vague one.

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

  // The mail limiter specifically — the only case where we may promise that an
  // email is already on its way. GoTrue uses this one code for both the
  // per-address cooldown (which names the wait) and the project's hourly cap.
  // The message is matched too because `code` is only populated by newer GoTrue
  // versions, and "email rate limit exceeded" names the limiter on its own (the
  // cooldown wording does not, so a code-less cooldown falls through below).
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
  return null;
}
