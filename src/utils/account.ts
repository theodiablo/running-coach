import { PASSWORD_MIN_LENGTH } from "../constants";
import type { User } from "@supabase/supabase-js";

// Pure helpers behind the Settings -> Account credential forms. Kept out of the
// component files so they're unit-testable (and so fast-refresh stays happy).

// Mirrors the server policy (supabase/config.toml: minimum_password_length +
// password_requirements = "lower_upper_letters_digits"). Checked client-side so
// a weak password fails instantly instead of after a round trip; the server
// stays the authority.
export type PasswordProblem = "short" | "classes" | "mismatch";
export function passwordProblem(pw: string, confirm: string): PasswordProblem | null {
  if (pw.length < PASSWORD_MIN_LENGTH) return "short";
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) return "classes";
  if (pw !== confirm) return "mismatch";
  return null;
}

// An account with no `email` identity signed up through Google and has no
// password at all. For those, updateUser({password}) SETS a first one (and
// thereby enables email+password sign-in alongside Google) — so the UI says
// "Set a password", not "Change".
export function hasEmailIdentity(user: User): boolean {
  return !!user.identities?.some(i => i.provider === "email");
}
