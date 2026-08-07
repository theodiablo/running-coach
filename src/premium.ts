// Premium entitlement — the client half of the paid-tier seam.
//
// Server truth lives in profiles.premium_until / premium_since, which are
// service-role-writable ONLY (see 20260724130100_premium_until.sql). This
// module reads the caller's own row (allowed by the "profiles read own" RLS
// policy) purely so the UI can render the right affordance. It is NEVER the
// gate: every premium feature is enforced server-side in its edge function
// (route-suggest returns PREMIUM_REQUIRED; coach-agent raises the daily
// budget), so a tampered client gains nothing.
//
// Nothing here touches `db`/app_state: that blob is client-writable, and
// entitlement is per-account server truth, not synced user state.

// @ts-expect-error Shared Deno/Vitest ESM has no TypeScript declaration file.
import * as sharedPremium from "../supabase/functions/_shared/premium.mjs";
import { supabase } from "./supabase";

// The entitlement predicate itself lives with the edge functions so client and
// server can't drift on what counts as premium — see that file for why anything
// unparseable is deliberately FREE. Pure, so it can be re-evaluated on every
// render (an expiry flips the UI without a refetch).
export const isPremiumActive: (premiumUntil: string | null | undefined, now?: number) => boolean =
  (sharedPremium as { isPremiumActive: (u: string | null | undefined, now?: number) => boolean }).isPremiumActive;

// Read the caller's own premium_until. NEVER throws and never rejects: any
// failure (offline, RLS, missing row, transport) resolves null, i.e. the free
// tier, so a failed fetch degrades the UI instead of blocking the app. The
// server check is the real gate, so defaulting to free is safe — and the
// teaser sheet refetches on open, so a user who was offline at sign-in isn't
// stuck with a stale "locked" view for the whole session.
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

// Whether a free user may see the locked "coming soon" teaser for a premium
// feature. False until there's a purchase flow (a permanently locked button is
// App Store guideline 2.1 placeholder UI) — see docs/monetization.md for the
// unveil plan and why it must flip back to `!isIos`, not `true`.
// Annotated `boolean` so call sites don't narrow to a literal `false`.
export const canShowPremiumTeaser: boolean = false;
