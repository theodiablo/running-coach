import { getHrSource } from "./source";
import { readHrJournal } from "./hrJournal";
import { getPairedDevice } from "./device";
import { hasHealthConnectAuthorization } from "./healthconnect";
import { hasHealthKitAuthorization } from "../healthkit/import";
import { HR_MIN_COVERAGE, hrCoverage, hrSummary, mergeHrSamples, compactHrSamples } from "../utils/hr";
import { hrNudgeFor, type HrNudgeChoice } from "../utils/hrNudge";
import { isAndroid, isIos, isNative } from "../native";
import { logTrack } from "../geo/trackLog";
import type { BleHrSample } from "./ble";
import type { HrMethod, HrPending, Run } from "../types";

// What the two recorders (LiveRunTracker, IndoorTracker) share about heart rate.
// Both stream the same seam through the same useRunTracker, so the rules either
// side of it — which method is usable on THIS device, and how a finished
// session's HR is resolved — have to be one implementation, not two that drift.

export type RecorderHrSetup = {
  /** What this device can actually use, "off" when the synced method isn't ready here. */
  method: HrMethod;
  /** Which setup prompt Start should raise instead, if any. */
  nudge: HrNudgeChoice | null;
};

/**
 * What a recorder settles about HR before starting: the synced `hrMethod` narrowed to what
 * this device holds, falling back to "off" with a `nudge`, never blocking Start.
 */
export function recorderHrSetup(hrMethod: HrMethod, hrOptOut?: boolean): RecorderHrSetup {
  const pairedHrDevice = !!getPairedDevice();
  const healthConnectAuthorized = hasHealthConnectAuthorization();
  const healthKitAuthorized = hasHealthKitAuthorization();
  const ready = !isNative
    || (hrMethod || "off") === "off"
    || (hrMethod === "bluetooth" && pairedHrDevice)
    || (hrMethod === "healthconnect" && healthConnectAuthorized)
    || (hrMethod === "healthkit" && healthKitAuthorized);
  return {
    method: ready ? hrMethod : "off",
    nudge: hrNudgeFor({
      isNative, isAndroid, isIos, hrMethod,
      healthConnectAuthorized, healthKitAuthorized, pairedHrDevice, hrOptOut: !!hrOptOut,
    }),
  };
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

/**
 * Resolve a finished session's HR (GPS or indoor); branches on the source's `live` flag, never a
 * method id. Native journal only for a live source; average only above HR_MIN_COVERAGE.
 */
export async function resolveRunHr({ hrSrc, liveSamples, durationSec, startMs, endMs }: {
  hrSrc: HrSourceLike | null;
  liveSamples: BleHrSample[];
  durationSec: number;
  startMs: number;
  endMs: number;
}): Promise<ResolvedRunHr> {
  const journalled = hrSrc?.live ? await readHrJournal() : [];
  const samples = mergeHrSamples(liveSamples, journalled);
  // Summary off the full stream so a one-beat peak still counts toward hrMax.
  const { hrAvg, hrMax } = hrSummary(samples);
  const out: ResolvedRunHr = { samples: compactHrSamples(samples), hr: null, hrMax: null, hrPending: null, partialCoverage: null };

  if (hrAvg != null) {
    const coverage = hrCoverage(samples, durationSec);
    if (coverage >= HR_MIN_COVERAGE) { out.hr = hrAvg; out.hrMax = hrMax; }
    else out.partialCoverage = coverage;
    // The last line of the diagnostic story: how much of the run each layer
    // actually contributed, and whether the coverage gate kept the average.
    // `journal >> live` means the link was healthy and JS was not being fed.
    logTrack("hr-save", {
      ok: out.hr != null,
      n: samples.length,
      msg: `live=${liveSamples.length} journal=${journalled.length} merged=${samples.length} `
        + `coverage=${Math.round(coverage * 100)}% of ${Math.round(durationSec)}s`
        + (out.hr == null ? " → no run average (below gate)" : ` → ${hrAvg}bpm`),
    });
    return out;
  }
  if (hrSrc?.live) logTrack("hr-save", { ok: false, n: 0, msg: "no samples at all (live source)" });
  if (hrSrc && !hrSrc.live) {
    let res = null;
    try { res = await hrSrc.fetchRange(startMs, endMs); }
    catch { /* unsynced — leave null */ }
    if (res?.hrAvg) { out.hr = res.hrAvg; out.hrMax = res.hrMax ?? null; }
    else out.hrPending = { start: startMs, end: endMs, source: hrSrc.id };
  }
  return out;
}

/**
 * The saved-run fields for a resolved HR. The HealthKit marker rides its own field:
 * shipped Android clients strip any `hrPending` not from "healthconnect" from the blob.
 */
export function runHrFields(resolved: ResolvedRunHr): Partial<Run> {
  return {
    ...(resolved.hr != null ? { hr: resolved.hr, hrMax: resolved.hrMax } : {}),
    ...(resolved.hrPending
      ? (resolved.hrPending.source === "healthkit" ? { hrPendingHk: resolved.hrPending } : { hrPending: resolved.hrPending })
      : {}),
  };
}
