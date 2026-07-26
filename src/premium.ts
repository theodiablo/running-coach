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

import { supabase } from "./supabase";

// Whether a premium_until value is still active. Pure, so it can be re-evaluated
// on every render (an expiry flips the UI without a refetch).
//
// Deliberately strict about what counts as premium: anything unparseable is
// FREE. That covers null/undefined, an empty string, and the string "infinity"
// (Postgres accepts timestamptz 'infinity' and PostgREST serialises it as that
// literal, which Date.parse() reports as NaN) — the migration bans it, and this
// keeps a stray grant from reading as premium here but free in the edge
// function, or vice versa. Exactly-now is expired.
export function isPremiumActive(premiumUntil: string | null | undefined, now: number = Date.now()): boolean {
  if (!premiumUntil) return false;
  const t = Date.parse(premiumUntil);
  return Number.isFinite(t) && t > now;
}

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
