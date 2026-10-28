// The one reading of a live row's state, shared by the single-runner view and
// every row of the follow list. Silence is ambiguous by construction, so this
// only ever says how long it has been quiet (docs/live-sharing.md, "Staleness").

// How long without an update before we say so. Generously above the publisher's
// 30s cadence: a couple of missed uploads is a red light, not an incident.
export const QUIET_MS = 180000;

export type LiveRowState = {
  ended: boolean;
  paused: boolean;
  quiet: boolean;
  quietMs: number;
  updatedAt: number;
};

// A paused run publishes nothing BY DESIGN (the pause itself was pushed through
// as a status change), so silence after one is expected, not a lost signal.
export function liveRowState(row: { status: string; updated_at: string } | null, now: number): LiveRowState {
  const updatedAt = row ? Date.parse(row.updated_at) : NaN;
  const quietMs = Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : 0;
  const ended = !row || row.status === "ended";
  const paused = row?.status === "paused";
  return { ended, paused, quiet: !ended && !paused && quietMs >= QUIET_MS, quietMs, updatedAt };
}

// The "Updated x ago" line as an i18n key + params (liveShare.watch.*).
export function freshness(state: LiveRowState): { key: string; params?: Record<string, number> } | null {
  if (!Number.isFinite(state.updatedAt)) return null;
  const secs = Math.round(state.quietMs / 1000);
  if (secs < 15) return { key: "liveShare.watch.updatedNow" };
  if (secs < 60) return { key: "liveShare.watch.updatedSecs", params: { secs } };
  return { key: "liveShare.watch.updatedMins", params: { mins: Math.round(secs / 60) } };
}
