import { getHrSource } from "./source";
import { readHrJournal } from "./hrJournal";
import { getPairedDevice } from "./device";
import { hasHealthConnectAuthorization } from "./healthconnect";
import { hasHealthKitAuthorization } from "../healthkit/import";
import { HR_MIN_COVERAGE, hrCoverage, hrSummary, mergeHrSamples } from "../utils/hr";
import { isNative } from "../native";
import type { BleHrSample } from "./ble";
import type { HrMethod, HrPending, Run } from "../types";

// What the two recorders (LiveRunTracker, IndoorTracker) share about heart rate.
// Both stream the same seam through the same useRunTracker, so the rules either
// side of it — which method is usable on THIS device, and how a finished
// session's HR is resolved — have to be one implementation, not two that drift.

// The synced `settings.hrMethod` is a preference; the pairing/authorization it
// needs is per-install. Resolve it against this device's local state, falling
// back to "off" when the selected source can't actually be used here (the
// recorder then prompts the user to set it up, without blocking Start).
// getHrSource already nulls an off-platform method, so no platform check here.
export function effectiveHrMethod(hrMethod: HrMethod): HrMethod {
  const ready = !isNative
    || (hrMethod || "off") === "off"
    || (hrMethod === "bluetooth" && !!getPairedDevice())
    || (hrMethod === "healthconnect" && hasHealthConnectAuthorization())
    || (hrMethod === "healthkit" && hasHealthKitAuthorization());
  return ready ? hrMethod : "off";
}

export type ResolvedRunHr = {
  /** The stream that gets stored as the route's sidecar (live sources only). */
  samples: BleHrSample[];
  hr: number | null;
  hrMax: number | null;
  hrPending: HrPending | null;
  /** Set when a live stream covered too little of the session to average it. */
  partialCoverage: number | null;
};

type HrSourceLike = NonNullable<ReturnType<typeof getHrSource>>;
type PostRunHrSource = { id: string; fetchRange: (startMs: number, endMs: number) => Promise<{ hrAvg?: number; hrMax?: number | null }> };

/**
 * Resolve a finished session's heart rate, for a GPS run and an indoor session
 * alike. Branches on the source's `live` flag, never on a method id, so a new
 * post-run source needs no edit here.
 *
 * A LIVE source (Bluetooth) has been streaming into `liveSamples`; the native
 * journal is folded in first, since on Android the WebView is frozen whenever
 * the app is backgrounded and JS only ever saw the beats it was awake for. The
 * journal is read ONLY for a live source — the same condition that armed it —
 * because anything on disk under a post-run source belongs to an earlier BLE
 * run, and merging it would both invent this session's HR and, by producing an
 * average, skip the store fetch below.
 *
 * A run-level average is claimed only above HR_MIN_COVERAGE: a dropped link
 * leaves the mean of whatever fragment survived, and that number goes on to
 * feed the coach, the zones and race predictions. Below it the samples still
 * save and the caller reports `partialCoverage`.
 *
 * A POST-RUN source is queried over the session window; an empty result stamps
 * a pending marker the next load relinks.
 */
export async function resolveRunHr({ hrSrc, liveSamples, durationSec, startMs, endMs }: {
  hrSrc: HrSourceLike | null;
  liveSamples: BleHrSample[];
  durationSec: number;
  startMs: number;
  endMs: number;
}): Promise<ResolvedRunHr> {
  const samples = mergeHrSamples(liveSamples, hrSrc?.live ? await readHrJournal() : []);
  const { hrAvg, hrMax } = hrSummary(samples);
  const out: ResolvedRunHr = { samples, hr: null, hrMax: null, hrPending: null, partialCoverage: null };

  if (hrAvg != null) {
    const coverage = hrCoverage(samples, durationSec);
    if (coverage >= HR_MIN_COVERAGE) { out.hr = hrAvg; out.hrMax = hrMax; }
    else out.partialCoverage = coverage;
    return out;
  }
  if (hrSrc && !hrSrc.live) {
    let res = null;
    try { res = await (hrSrc as unknown as PostRunHrSource).fetchRange(startMs, endMs); }
    catch { /* unsynced — leave null */ }
    if (res?.hrAvg) { out.hr = res.hrAvg; out.hrMax = res.hrMax ?? null; }
    else out.hrPending = { start: startMs, end: endMs, source: hrSrc.id };
  }
  return out;
}

/**
 * The saved-run fields for a resolved HR. The HealthKit marker rides its own
 * field: shipped Android clients strip any `hrPending` whose source isn't
 * "healthconnect" from the synced blob, which would destroy an iPhone's
 * deferred HR before it could resolve.
 */
export function runHrFields(resolved: ResolvedRunHr): Partial<Run> {
  return {
    ...(resolved.hr != null ? { hr: resolved.hr, hrMax: resolved.hrMax } : {}),
    ...(resolved.hrPending
      ? (resolved.hrPending.source === "healthkit" ? { hrPendingHk: resolved.hrPending } : { hrPending: resolved.hrPending })
      : {}),
  };
}
