// Native screen-off uploads — the contract both ends must agree on.
//
// Plain ESM so it imports from Deno (the live-publish edge function) AND from
// Vitest (src/live/publishToken.ts re-exports it), the liveShare.mjs pattern.
// The publish token is a WRITE capability with the same shape and entropy as
// the share token; the payload caps and validators here are what keep an
// unauthenticated endpoint that writes from becoming a storage side channel.

import { SHARE_TOKEN_RE } from "./liveShare.mjs";

// Same shape as share_token on purpose: one regex, one CHECK-constraint idiom,
// one minting routine. A publish token that drifted from the constraint would
// make every native upload 23514 silently.
export const PUBLISH_TOKEN_RE = SHARE_TOKEN_RE;

export function isValidPublishToken(value) {
  return typeof value === "string" && PUBLISH_TOKEN_RE.test(value);
}

// One batch = at most ~5 minutes of worst-case 2s-apart accepted fixes. The
// native uploader sends every 30s, so a real batch is ~15 points; the cap is
// generous headroom for a recovery burst, not a workload.
export const PUBLISH_MAX_POINTS = 300;

// A point is [lat, lng, tEpochMs, alt|null]; null is a gap marker (tunnel —
// the line must not bridge it). Mirrors src/utils/geo.ts's tuple.
function isValidPoint(p) {
  if (p === null) return true; // gap marker
  if (!Array.isArray(p) || p.length < 3 || p.length > 4) return false;
  const [lat, lng, t, alt] = p;
  return typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    typeof lng === "number" && Number.isFinite(lng) && lng >= -180 && lng <= 180 &&
    typeof t === "number" && Number.isFinite(t) && t > 0 &&
    (alt === undefined || alt === null || (typeof alt === "number" && Number.isFinite(alt)));
}

// Whole-batch validation: shape only. Timestamp plausibility is NOT judged
// here — the RPC clamps rather than rejects, so a skewed device clock degrades
// instead of poisoning every retry of the same batch.
export function isValidPointBatch(points) {
  return Array.isArray(points) && points.length > 0 &&
    points.length <= PUBLISH_MAX_POINTS && points.every(isValidPoint);
}

// Stats whitelist: exactly the four numbers the watcher renders, everything
// else dropped, non-finite coerced to null so the RPC keeps the stored value.
// A free-form stats object would bypass the points cap as unbounded jsonb.
export function sanitizeStats(stats) {
  const pick = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const s = stats && typeof stats === "object" && !Array.isArray(stats) ? stats : {};
  return {
    km: pick(s.km),
    durationSec: pick(s.durationSec),
    avgPace: pick(s.avgPace),
    curPace: pick(s.curPace),
  };
}
