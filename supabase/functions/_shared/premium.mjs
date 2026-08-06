// What "premium" means, for both halves of the seam.
//
// The client renders affordances off this (src/premium.ts re-exports it) and
// every edge function gates off it, so the two can never disagree about whether
// a given premium_until is still active — the failure mode this exists to
// prevent is a grant that reads as premium in the UI and free on the server.
//
// Deliberately strict: anything unparseable is FREE. That covers null, an empty
// string, and the literal "infinity" (Postgres accepts timestamptz 'infinity'
// and PostgREST serialises it as that string, which Date.parse reports as NaN —
// the migration bans it, and this makes a stray grant fail closed either way).
// Exactly-now is expired.
//
// Plain ESM: imported by Deno edge functions, by Vitest, and by the browser
// bundle through src/premium.ts.
export function isPremiumActive(premiumUntil, now = Date.now()) {
  if (!premiumUntil) return false;
  const t = Date.parse(String(premiumUntil));
  return Number.isFinite(t) && t > now;
}
