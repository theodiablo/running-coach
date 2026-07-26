import type { Run } from "../types";
import type { ImportedRun } from "./types";

// THE one duplicate-run rule set, shared by watch scans, the registry's
// cross-provider pass, and file imports: (1) external-id match, (2) time-window
// overlap when both sides have a start instant, (3) fuzzy fallback — same date
// and distance within 10% (opt-out). Fuzzy matching is a trade-off: it catches
// hand-logged runs (no startedAt) at the cost of occasionally swallowing a
// distinct same-day run, so auto-scans keep it but file imports turn it off
// ({fuzzy:false}) — a user-picked export must never silently drop rows.
const FUZZY_KM_TOLERANCE = 0.1;

type RunLike = Partial<Run>;

function windowOf(r: RunLike): { start: number; end: number } | null {
  if (!r.startedAt || !r.durationSec) return null;
  const start = +new Date(r.startedAt);
  if (!Number.isFinite(start)) return null;
  return { start, end: start + r.durationSec * 1000 };
}

export function isDuplicateRun(
  cand: ImportedRun,
  existing: RunLike[],
  seenIds: string[] = [],
  { fuzzy = true }: { fuzzy?: boolean } = {},
): boolean {
  if (cand.hcId && seenIds.includes(cand.hcId)) return true;
  const cw = windowOf(cand);
  const cKm = Number(cand.km) || 0;
  for (const r of existing) {
    if (cand.hcId && r.hcId === cand.hcId) return true;
    if (cand.extId && r.extId === cand.extId) return true;
    const rw = windowOf(r);
    if (cw && rw) {
      if (rw.start < cw.end && cw.start < rw.end) return true;
    } else if (fuzzy && cKm > 0 && r.date === cand.date) {
      const rKm = Number(r.km) || 0;
      if (Math.abs(rKm - cKm) <= FUZZY_KM_TOLERANCE * Math.max(rKm, cKm)) return true;
    }
  }
  return false;
}
