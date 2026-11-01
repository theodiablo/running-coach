import { isIos } from "../native";
import { HK_AUTH_KEY } from "../constants";
import { getHealthKitPlugin, type HealthKitAvailability } from "./plugin";
import { newHkWorkouts, hkId } from "./mapping";
import { normalizeRoutePoints, normalizeHrSamples } from "../imports/series";
// Reuse the watch-import seen-ids list and window/threshold constants so the
// two health-store providers can't drift; on an iPhone the per-device list only
// ever holds "hk:"-prefixed ids.
import { getSeenIds, WATCH_SCAN_DAYS, WATCH_MIN_KM } from "../watch/import";
import type { ImportedRun } from "../imports/types";
import type { Run } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;

// One per-device marker covers HR reads AND workout import (one HealthKit sheet grants both). NEVER
// cleared by a permission probe (HealthKit hides read authorization; empty read means "no data"),
// only when HealthKit reports unavailable.
export function hasHealthKitAuthorization(): boolean {
  try { return localStorage.getItem(HK_AUTH_KEY) === "1"; }
  catch { return false; }
}

export function setHealthKitAuthorization(ok: boolean) {
  try {
    if (ok) localStorage.setItem(HK_AUTH_KEY, "1");
    else localStorage.removeItem(HK_AUTH_KEY);
  } catch { /* storage unavailable — non-fatal */ }
}

// Raw availability: "Available" | "NotSupported" (no NotInstalled — HealthKit
// ships with iOS). Any throw (plugin absent, iPad without Health, web) →
// "NotSupported".
export async function availability(): Promise<HealthKitAvailability> {
  try { return (await getHealthKitPlugin().checkAvailability())?.availability || "NotSupported"; }
  catch { return "NotSupported"; }
}

export async function isAvailable() { return (await availability()) === "Available"; }

// Show the HealthKit read-authorization sheet; granted:true means the flow completed, not that reads return data.
// KNOWN LIMITATION: a user who granted before the route scope was added keeps a valid marker, so the scan
// skips this re-request and their runs import totals-only until they toggle the integration in Settings.
// We don't invalidate the marker (it gates post-run HR) nor prompt during a passive scan.
export async function requestHealthKitPermissions(): Promise<boolean> {
  try {
    if (!(await isAvailable())) { setHealthKitAuthorization(false); return false; }
    const ok = !!(await getHealthKitPlugin().requestPermissions())?.granted;
    setHealthKitAuthorization(ok);
    return ok;
  } catch { setHealthKitAuthorization(false); return false; }
}

type ScanOptions = { enabled?: boolean; allowNativeRead?: boolean; days?: number; now?: number };

// Read finished workouts from Apple Health over the last `days`, map to runs, drop already-logged ones.
// Never throws; the bridge is touched only on iOS with the local auth marker (HealthKit grants are
// per-install, the synced preference is not enough). The marker is NOT cleared on an empty/failed read.
export async function scanHealthKitWorkouts(
  runs: Run[],
  { enabled = true, allowNativeRead = true, days, now = Date.now() }: ScanOptions = {},
): Promise<ImportedRun[]> {
  const windowDays = days ?? WATCH_SCAN_DAYS;
  if (!enabled || !allowNativeRead || !isIos || !hasHealthKitAuthorization()) return [];
  try {
    if (!(await isAvailable())) return [];
    const res = await getHealthKitPlugin().readWorkouts({
      startTime: new Date(now - windowDays * DAY_MS).toISOString(),
      endTime: new Date(now).toISOString(),
    });
    const raws = res?.sessions || [];
    const news = newHkWorkouts(raws, runs || [], getSeenIds())
      .filter(r => (Number(r.km) || 0) >= WATCH_MIN_KM);
    if (!news.length) return [];
    // Fetch the GPS route + raw HR series for each NEW run only (post-dedupe), so
    // an imported Apple Watch run gets a map/pace curve/HR chart instead of just
    // totals. A failed or empty detail read degrades to totals-only. hcId ("hk:"+
    // uuid) links a mapped run back to its raw workout for the by-UUID lookup.
    const byHcId = new Map(raws.map(w => [hkId(w.id), w] as const));
    return await Promise.all(news.map(async (run): Promise<ImportedRun> => {
      const w = run.hcId ? byHcId.get(run.hcId) : undefined;
      if (!w) return run;
      try {
        const d = await getHealthKitPlugin().readWorkoutDetail({
          id: w.id, startTime: w.startTime, endTime: w.endTime,
        });
        const points = normalizeRoutePoints(d?.route);
        const hrSamples = normalizeHrSamples(d?.hrSamples);
        return {
          ...run,
          ...(points.length ? { points } : {}),
          ...(hrSamples.length ? { hrSamples } : {}),
        };
      } catch { return run; }
    }));
  } catch { return []; }
}
