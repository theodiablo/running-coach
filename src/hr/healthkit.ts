import { hrSummary } from "../utils/hr";
import { isIos } from "../native";
import { getHealthKitPlugin } from "../healthkit/plugin";
import {
  availability,
  isAvailable,
  hasHealthKitAuthorization,
  requestHealthKitPermissions,
} from "../healthkit/import";
import { flushPendingHrFor, type PatchHr, type PendingHrRun } from "./pending";

// Post-run HR source reading a tracked run's HR from Apple Health: the iOS mirror of healthConnectSource (same
// PostRunHrSource contract). LiveRunTracker calls fetchRange once on save, with a deferred flushPendingHkHr retry.
// HealthKit never reveals READ authorization: checkPermissions reports the local marker and only availability failure
// clears it; an unauthorized read comes back empty and stays hrPending.
export const healthKitSource = {
  id: "healthkit" as const,
  live: false as const,
  isAvailable,
  availability,

  requestPermissions: requestHealthKitPermissions,

  // Non-prompting "connected?" for Settings. The local marker is the only
  // signal HealthKit allows for read scopes.
  checkPermissions: async () => hasHealthKitAuthorization(),

  // Read heart-rate samples in [startMs, endMs] and reduce to {hr,hrAvg,hrMax}.
  // Returns null when nothing is available yet (watch not synced, or read
  // denied — indistinguishable by design) so the caller defers and retries.
  async fetchRange(startMs: number, endMs: number) {
    try {
      if (!isIos || !hasHealthKitAuthorization() || !(await isAvailable())) return null;
      const res = await getHealthKitPlugin().readHeartRate({
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(endMs).toISOString(),
      });
      const samples = (res?.samples || [])
        .map(s => ({ bpm: Math.round(s.bpm || 0), t: Number(s.t) }))
        .filter((s): s is { bpm: number; t: number } => s.bpm > 0 && s.t >= startMs && s.t <= endMs);
      if (!samples.length) return null;
      return hrSummary(samples);
    } catch { return null; }
  },
};

// Deferred relink for HealthKit pending markers (iOS sibling of flushPendingHr, same call sites). Markers live in the
// separate `hrPendingHk` field: shipped Android builds clear any `hrPending` with an unknown source.
export async function flushPendingHkHr(
  runs: PendingHrRun[],
  patch: PatchHr,
  { enabled = true, now = Date.now() }: { enabled?: boolean; now?: number } = {},
) {
  return flushPendingHrFor(runs, patch, {
    field: "hrPendingHk",
    sourceId: "healthkit",
    now,
    canRead: async () => enabled && isIos && hasHealthKitAuthorization() && (await isAvailable()),
    fetchRange: (startMs, endMs) => healthKitSource.fetchRange(startMs, endMs),
  });
}
