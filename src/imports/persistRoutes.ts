import { simplify } from "../utils/geo";
import { bestEffortsFromTrack } from "../utils/bestEfforts";
import { saveRoute, queuePendingRoute } from "../routes";
import type { ImportedRun } from "./types";
import type { Run } from "../types";

// Persist an imported run's transient route `points` (GPX/TCX; HealthKit route)
// and/or raw HR series (health-store imports), swapping them for a run_routes
// reference, with the same save-or-queue offline fallback as
// LiveRunTracker.handleSave. Runs with neither pass through untouched. This is
// THE step the ImportProvider contract assigns to the caller: providers return
// points/hrSamples, the save path persists them into the (blob-external)
// run_routes row, and neither reaches addRuns.
//
// A GPS trace rides `routeId` (History shows a map button). An HR-only sidecar
// (HR series, no GPS — the common Garmin/Samsung-on-Health-Connect case) rides
// the separate `hrRouteId`, so the run powers the detail HR chart/time-in-zone
// card without History offering a blank map. The raw HR stream sits in the same
// `stats.hrSamples` sidecar a BLE-strap run uses.
export async function persistImportedRoute(r: ImportedRun): Promise<Partial<Run>> {
  const { points, hrSamples, ...run } = r;
  const hasRoute = !!points?.length;
  const hasHr = !!hrSamples?.length;
  if (!hasRoute && !hasHr) return run;
  const pts = hasRoute ? simplify(points!, 5) : [];
  // Same measurement a live-tracked run gets, off the same simplified points, so
  // an imported GPS run ranks against phone-tracked ones on equal terms. An
  // HR-only import has no distance axis and keeps the whole-run estimate.
  const efforts = hasRoute ? { bestEfforts: bestEffortsFromTrack(pts) } : {};
  const stats = {
    km: run.km || 0,
    durationSec: run.durationSec || 0,
    elevation: run.elevation || 0,
    avgPace: run.km ? Math.round((run.durationSec || 0) / run.km) : 0,
    ...(hasHr ? { hrSamples } : {}),
  };
  try {
    const id = await saveRoute({ points: pts, stats });
    return hasRoute ? { ...run, ...efforts, routeId: id } : { ...run, hrRouteId: id };
  } catch {
    // Offline / save failed. TRADE-OFF (deliberate): only a GPS trace is queued
    // for retry; an HR-only sidecar (no GPS — the HealthKit / Health Connect HR
    // case) is dropped here instead.
    //   Consequence: a run imported while Supabase is unreachable still saves
    //   with its avg/max HR aggregates, but the raw ~1Hz stream is lost, so the
    //   detail HR chart + time-in-zone card won't populate for that one run.
    //   Why accept it: the pending queue + flushPendingRoutes relink only know
    //   how to reattach a `routeId`. Supporting an offline HR-only sidecar would
    //   need a parallel queue that relinks `hrRouteId` — real complexity for
    //   enrichment-only data (the HR is still summarised on the run). GPS traces
    //   ARE user-authored data worth that machinery; a derived series isn't.
    if (!hasRoute) return run;
    const routeTmp = "rt" + Date.now();
    queuePendingRoute({ tmpId: routeTmp, points: pts, stats });
    return { ...run, ...efforts, routeTmp, routePending: true };
  }
}

export function persistImportedRoutes(runs: ImportedRun[]): Promise<Partial<Run>[]> {
  return Promise.all(runs.map(persistImportedRoute));
}
