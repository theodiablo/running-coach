import type { HrPending, Run } from "../types";

export const HR_PENDING_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export type PendingHrRun = Pick<Run, "id" | "hr" | "hrMax" | "hrPending" | "hrPendingHk"> & Record<string, unknown>;
export type PatchHr = (id: string, fields: Partial<Pick<Run, "hr" | "hrMax">>) => void;

type FlushArgs = {
  // Which run field this flusher owns: "hrPending" (Health Connect; semantics frozen by
  // shipped Android clients) or "hrPendingHk" (HealthKit). Separate fields so a client never
  // clears a marker only the other platform could resolve (old Android clears any
  // hrPending with an unknown source).
  field: "hrPending" | "hrPendingHk";
  // The hrPending.source expected in this field; anything else is corrupt and
  // gets cleared. Legacy markers with no source count as "healthconnect".
  sourceId: string;
  // Device-local gate evaluated before the native bridge is touched (auth
  // marker + platform + preference). Sync preferences alone are never enough.
  canRead: () => Promise<boolean> | boolean;
  fetchRange: (startMs: number, endMs: number) => Promise<{ hrAvg?: number | null; hrMax?: number | null } | null>;
  now?: number;
};

function windowOf(hrPending: HrPending | null | undefined) {
  const start = Number(hrPending?.start);
  const end = Number(hrPending?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
}

// Deferred post-run HR relink for Health Connect and HealthKit (like routes.ts/
// flushPendingRoutes): on load/foreground, retry the health store for runs with a pending
// marker. Bad markers are cleared first without touching the native bridge. patch(id, {})
// clears THIS flusher's field without touching hr/hrMax, so manual HR is never overwritten.
export async function flushPendingHrFor(
  runs: PendingHrRun[],
  patch: PatchHr,
  { field, sourceId, canRead, fetchRange, now = Date.now() }: FlushArgs,
) {
  const pending = (runs || []).filter(r => r[field]);
  if (!pending.length) return;
  const live: { run: PendingHrRun & { id: string }; win: { start: number; end: number } }[] = [];
  for (const r of pending) {
    if (!r.id) continue;
    const marker = r[field] as HrPending;
    const win = windowOf(marker);
    const sourceOk = (marker?.source || "healthconnect") === sourceId;
    if (r.hr != null || !win || !sourceOk || now - win.end > HR_PENDING_MAX_AGE_MS) { patch(r.id, {}); continue; }
    live.push({ run: r as PendingHrRun & { id: string }, win });
  }
  if (!live.length) return;
  if (!(await canRead())) return; // store unavailable/unpermitted here — leave for next load
  for (const { run, win } of live) {
    const s = await fetchRange(win.start, win.end);
    if (s && s.hrAvg) patch(run.id, { hr: s.hrAvg, hrMax: s.hrMax ?? null });
  }
}
