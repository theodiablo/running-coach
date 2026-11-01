// Client half of the premium seam. Server truth is profiles.premium_until / premium_since, service-role-writable ONLY.
// This reads the caller's own row (RLS "profiles read own") purely for UI and is NEVER the gate: every premium feature
// is enforced server-side in its edge function. Never touches `db`/app_state, which is client-writable.

// @ts-expect-error Shared Deno/Vitest ESM has no TypeScript declaration file.
import * as sharedPremium from "../supabase/functions/_shared/premium.mjs";
import { supabase } from "./supabase";

// The entitlement predicate itself lives with the edge functions so client and
// server can't drift on what counts as premium — see that file for why anything
// unparseable is deliberately FREE. Pure, so it can be re-evaluated on every
// render (an expiry flips the UI without a refetch).
export const isPremiumActive: (premiumUntil: string | null | undefined, now?: number) => boolean =
  (sharedPremium as { isPremiumActive: (u: string | null | undefined, now?: number) => boolean }).isPremiumActive;

// Read the caller's own premium_until. NEVER throws: any failure resolves null (free tier), so a failed fetch degrades the
// UI instead of blocking the app; safe because the server is the real gate. The teaser sheet refetches on open.
export async function fetchPremiumUntil(uid: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("profiles").select("premium_until").eq("id", uid).maybeSingle();
    if (error) return null;
    const value = data?.premium_until;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

// Whether a free user may see the locked "coming soon" teaser. False until there is a purchase flow (a permanently locked
// button is App Store 2.1 placeholder UI); unveil plan in docs/monetization.md (flip back to `!isIos`, not `true`).
// Annotated `boolean` so call sites don't narrow to a literal `false`.
export const canShowPremiumTeaser: boolean = false;
