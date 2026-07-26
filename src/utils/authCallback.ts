import { POLAR_DEEP_LINK } from "../polarPreinit";

// Pure classification of a native deep-link URL (appUrlOpen / getLaunchUrl) so
// App.tsx's handler is a plain switch and the routing rules are unit-testable
// without mounting App. Order encodes priority:
//   1. Polar OAuth return — its ?code= is NOT a Supabase auth code and must
//      never reach exchangeCodeForSession (see polarPreinit.ts).
//   2. Provider error (user cancelled the consent screen) — surface it.
//   3. Email OTP confirmation (?token_hash=&type=email_change) — sent by the
//      email-change flow (Settings -> Account); Supabase's PKCE ?code= path
//      does not cover these links, they need verifyOtp.
//   4. Supabase PKCE ?code= — OAuth sign-in return.
export type AuthCallback =
  | { kind: "polar"; code: string | null; state: string | null }
  | { kind: "error"; message: string }
  | { kind: "otp"; tokenHash: string; otpType: "email_change" }
  | { kind: "code"; code: string }
  | { kind: "none" };

export function classifyAuthUrl(url: string): AuthCallback {
  if (url.startsWith(POLAR_DEEP_LINK)) {
    try {
      const p = new URL(url).searchParams;
      return { kind: "polar", code: p.get("code"), state: p.get("state") };
    } catch {
      return { kind: "polar", code: null, state: null };
    }
  }
  let params;
  try { params = new URL(url).searchParams; } catch { return { kind: "none" }; }
  const provErr = params.get("error_description") || params.get("error");
  if (provErr) return { kind: "error", message: provErr };
  const tokenHash = params.get("token_hash");
  if (tokenHash && params.get("type") === "email_change") {
    return { kind: "otp", tokenHash, otpType: "email_change" };
  }
  const code = params.get("code");
  if (code) return { kind: "code", code };
  return { kind: "none" };
}
