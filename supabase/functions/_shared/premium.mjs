// What "premium" means for both halves of the seam: the client (src/premium.ts re-exports this) and every edge
// function gate off it, so a premium_until can't read premium in the UI and free on the server.
// Strict: anything unparseable is FREE (null, "", and Postgres' 'infinity', which Date.parse reads as NaN); exactly-now is expired.
// Plain ESM: imported by Deno, Vitest and the browser bundle.
export function isPremiumActive(premiumUntil, now = Date.now()) {
  if (!premiumUntil) return false;
  const t = Date.parse(String(premiumUntil));
  return Number.isFinite(t) && t > now;
}
