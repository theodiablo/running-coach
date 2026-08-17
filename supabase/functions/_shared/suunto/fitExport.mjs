// Which Suunto endpoint actually serves a workout's FIT file — the one piece
// of the import that could not be read from public docs, and the one whose
// failure is invisible from the app.
//
// The first live pass settled it the hard way: `/v2/workouts` lists workouts
// fine, and `/v2/workouts/exportFit/<key>` answers 401 with the very same
// token and subscription key. So every import degraded to the summary
// fallback, which on screen reads as "no route was recorded for this run" and
// a distance rounded to 100 m — never as an endpoint error.
//
// Swapping one guess for another would be the same bet again, so the function
// walks these candidates instead and remembers the one that returned real FIT
// bytes (`sync_state.fitVariant`): the endpoint calibrates itself on the first
// download and costs one request per download after that.
//
// Ordered most-likely-first. Suunto's own portal names the operation
// `export-user-workout-in-fit` under a SINGULAR `workout` resource (only the
// listing is plural), and its getting-started curl passes the JWT bare, with
// no `Bearer` prefix — so path and auth style are both varied.
//
// Plain ESM: imported by the Deno edge function and by Vitest.

export const FIT_VARIANTS = [
  { id: "workout-bearer", plural: false, bearer: true },
  { id: "workouts-bearer", plural: true, bearer: true },
  { id: "workout-raw", plural: false, bearer: false },
  { id: "workouts-raw", plural: true, bearer: false },
];

export function fitVariantPath(variant, key) {
  return `/v2/${variant.plural ? "workouts" : "workout"}/exportFit/${encodeURIComponent(key)}`;
}

export function fitVariantAuth(variant, token) {
  return variant.bearer ? `Bearer ${token}` : token;
}

// A calibrated variant is tried first; the others stay behind it as the net for
// the day Suunto moves the endpoint. The caller stops after the first one when
// it answered 404/410 — on a KNOWN-good path that means this workout has no
// FIT, not that another path might.
export function fitVariantsToTry(memo) {
  const known = FIT_VARIANTS.find(v => v.id === memo);
  return known ? [known, ...FIT_VARIANTS.filter(v => v !== known)] : [...FIT_VARIANTS];
}

// A 2xx alone must never confirm a variant: an APIM notice or a JSON error
// body would be memoised as the endpoint and poison every later download with
// it. ".FIT" sits at bytes 8-11 of every FIT file.
export function looksLikeFit(bytes) {
  if (!bytes || bytes.length < 14) return false;
  return bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54;
}
