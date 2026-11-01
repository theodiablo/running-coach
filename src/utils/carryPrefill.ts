import type { Run } from "../types";

// What a recorder or importer measured that the run form cannot edit (trace reference,
// best efforts, provenance) must survive review to `addRuns`. Inverted from an allowlist
// (a forgotten `extId` made every sync re-list a workout): new Run fields ride through;
// only fields the form OWNS are named, e.g. `activity` (cleared when type leaves OTHER).
const FORM_OWNED = new Set([
  "date", "type", "activity", "km", "durationSec", "hr", "hrMax", "elevation",
  "effort", "notes",
]);

// Not run data: `pace` is a display hint, `session`/`sessionOffered` name the
// plan session the save ticks off and how it got there (RunningCoach consumes
// them from the prefill), `celebrated` says the recorder already showed this
// run's best efforts, and `id` is minted by addRuns.
const NOT_RUN_DATA = new Set(["pace", "session", "sessionOffered", "celebrated", "id"]);

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
