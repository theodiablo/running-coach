// Which Suunto endpoint serves a workout's FIT file — the one piece of the
// import that could not be read from public docs, and the one whose failure is
// invisible from the app.
//
// The documented route is `GET /v3/workouts/{workoutIdOrKey}/fit` (partner
// docs, behind the API agreement). It is a **different API version and path
// shape** from the workout listing this function still uses (`/v2/workouts`),
// which is exactly how the original guess went wrong: it extrapolated the FIT
// path from the listing's, and `/v2/workouts/exportFit/<key>` answers 401 with
// the very same token and subscription key. Every import then took the summary
// fallback, which on screen reads as "no route was recorded for this run" and a
// distance rounded to 100 m — never as an endpoint error.
//
// So the documented route leads, and the older shapes stay behind it as a net.
// The function walks them in order and remembers the one that returned real FIT
// bytes (`sync_state.fitVariant`): one request per download from then on, and
// the day Suunto moves the endpoint again it re-calibrates instead of silently
// degrading every run.
//
// Plain ESM: imported by the Deno edge function and by Vitest.

export const FIT_VARIANTS = [
  { id: "v3-fit", path: "/v3/workouts/{key}/fit", bearer: true },
  // Suunto's own getting-started curl passes the JWT bare, with no `Bearer`
  // prefix; the v2 listing accepts both, so v3 might not.
  { id: "v3-fit-raw", path: "/v3/workouts/{key}/fit", bearer: false },
  // Pre-v3 shape, kept as the net for an account still served by the old API.
  { id: "v2-exportfit", path: "/v2/workout/exportFit/{key}", bearer: true },
];

export function fitVariantPath(variant, key) {
  return variant.path.replace("{key}", encodeURIComponent(key));
}

export function fitVariantAuth(variant, token) {
  return variant.bearer ? `Bearer ${token}` : token;
}

// A calibrated variant is tried first; the others stay behind it for the day
// the endpoint moves. The caller stops after the first one when it answered
// 404/410 — on a KNOWN-good path that means this workout has no FIT, not that
// another path might.
export function fitVariantsToTry(memo) {
  const known = FIT_VARIANTS.find(v => v.id === memo);
  return known ? [known, ...FIT_VARIANTS.filter(v => v !== known)] : [...FIT_VARIANTS];
}

// A 2xx alone must never confirm a variant: an APIM notice, or a JSON envelope
// pointing at a download URL, would be memoised as the endpoint and poison
// every later download with it. ".FIT" sits at bytes 8-11 of every FIT file.
export function looksLikeFit(bytes) {
  if (!bytes || bytes.length < 14) return false;
  return bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54;
}
