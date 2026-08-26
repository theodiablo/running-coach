// Which Suunto endpoint serves a workout's FIT file.
//
// Documented partner route, and a different API version and path shape from the
// workout listing — extrapolating one from the other is how the original guess
// (`/v2/workouts/exportFit/<key>`, 401 with the same token) degraded every
// import to summary-only, which on screen reads as "no route was recorded for
// this run" rather than as an error.
//
// Plain ESM: imported by the Deno edge function and by Vitest.

export const fitPath = key => `/v3/workouts/${encodeURIComponent(key)}/fit`;

// A 2xx alone doesn't mean FIT bytes: an APIM notice, or a JSON envelope
// pointing at a download URL, arrives as 200 too. ".FIT" sits at bytes 8-11 of
// every FIT file.
export function looksLikeFit(bytes) {
  if (!bytes || bytes.length < 14) return false;
  return bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54;
}

// Is a failed download this workout's own answer, or possibly a wrong route?
// A hard miss (404/410) means "no FIT for this workout" ONLY on a route this
// connection has already been served a FIT from (`sync_state.fitOk`): a wrong
// route answers 404 for EVERY workout, and calling that terminal degrades every
// import to summary-only, permanently and with no retry. Unproven, the caller
// keeps it transient and the client's per-workout retry budget decides.
export const fitMissIsTerminal = (status, routeProven) =>
  !!routeProven && (status === 404 || status === 410);
