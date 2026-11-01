// Which Suunto endpoint serves a workout's FIT file: the documented partner route, a different API version and
// path shape from the listing; extrapolating one from the other (`/v2/workouts/exportFit/<key>`, 401) degraded
// every import to summary-only. Plain ESM: imported by the Deno edge function and Vitest.

export const fitPath = key => `/v3/workouts/${encodeURIComponent(key)}/fit`;

// A 2xx alone doesn't mean FIT bytes: an APIM notice, or a JSON envelope
// pointing at a download URL, arrives as 200 too. ".FIT" sits at bytes 8-11 of
// every FIT file.
export function looksLikeFit(bytes) {
  if (!bytes || bytes.length < 14) return false;
  return bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54;
}

// Is a failed download this workout's own answer, or a wrong route? A hard miss (404/410) means "no FIT" ONLY on
// a route already proven for this connection (`sync_state.fitOk`): a wrong route 404s EVERY workout, and calling
// that terminal degrades imports permanently. Unproven, the caller keeps it transient (client retry budget).
export const fitMissIsTerminal = (status, routeProven) =>
  !!routeProven && (status === 404 || status === 410);
