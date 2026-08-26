import type { Run } from "../types";

// What a recorder or importer measured that the run form cannot edit — the GPS
// trace reference, best efforts, import provenance — has to survive the review
// step on its way to `addRuns`.
//
// This used to be an allowlist of individual spreads in LogView, and a field
// left off it was lost silently: `extId` went missing for every cloud import,
// so each sync re-listed the same workout and reported "no new runs". Inverting
// it means a new field on Run rides through by default, and only a field the
// form OWNS has to be named.
//
// `activity` is one of those: the form seeds it and clears it when the type
// moves off OTHER, so an edited run can't keep claiming it was done on a bike.
const FORM_OWNED = new Set([
  "date", "type", "activity", "km", "durationSec", "hr", "hrMax", "elevation",
  "effort", "notes",
]);

// Not run data: `pace` is a display hint, `wNum`/`sId` name the plan session
// the save ticks off (RunningCoach consumes them from the prefill), and `id` is
// minted by addRuns.
const NOT_RUN_DATA = new Set(["pace", "wNum", "sId", "id"]);

export function carryPrefill(prefill: Partial<Run> | null | undefined): Partial<Run> {
  if (!prefill) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(prefill)) {
    if (v == null || FORM_OWNED.has(k) || NOT_RUN_DATA.has(k)) continue;
    out[k] = v;
  }
  // A queued trace is only meaningful as a pair; both emitters set them
  // together, but deriving it keeps a lone routeTmp from saving as resolved.
  if (out.routeTmp) out.routePending = true;
  return out as Partial<Run>;
}
