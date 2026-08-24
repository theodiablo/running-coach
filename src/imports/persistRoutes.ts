import { simplify } from "../utils/geo";
import { bestEffortsFromTrack } from "../utils/bestEfforts";
import { saveRoute, queuePendingRoute } from "../routes";
import type { ImportedRun } from "./types";
import type { Run } from "../types";

// Swaps an imported run's transient `points`/`hrSamples` for a run_routes
// reference, so neither reaches addRuns and the synced blob. A GPS trace rides
// `routeId` (History shows a map button); an HR-only sidecar rides the separate
// `hrRouteId`, so the detail HR chart works without History offering a blank
// map. Runs with neither pass through untouched.
export async function persistImportedRoute(r: ImportedRun): Promise<Partial<Run>> {
  // providerId names the source in the import toast and goes no further;
  // discarding it IS the point, so the binding is deliberately unused.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { points, hrSamples, providerId, ...run } = r;
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
    // Offline: only a GPS trace is queued for retry. The pending queue relinks
    // a `routeId` only, and a parallel `hrRouteId` queue isn't worth it for
    // enrichment-only data — the run still saves with its avg/max HR, it just
    // loses the raw series behind the detail chart.
    if (!hasRoute) return run;
    const routeTmp = "rt" + Date.now();
    queuePendingRoute({ tmpId: routeTmp, points: pts, stats });
    return { ...run, ...efforts, routeTmp, routePending: true };
  }
}

export function persistImportedRoutes(runs: ImportedRun[]): Promise<Partial<Run>[]> {
  return Promise.all(runs.map(persistImportedRoute));
}
