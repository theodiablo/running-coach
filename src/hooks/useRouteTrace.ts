import { useEffect, useState } from "react";
import { getRoute, getPendingRoute } from "../routes";
import type { TrackPoint } from "../components/RouteMap";
import type { Run } from "../types";

// A loaded GPS trace: the simplified points plus the freeform stats sidecar
// (which now also carries the raw HR stream as `stats.hrSamples` for BLE runs).
export type RouteData = { points: (TrackPoint | null)[]; stats?: Record<string, unknown> } | null | undefined;

// Lazily load a run's saved GPS trace (kept out of the synced runs blob): from Supabase by
// `routeId`, or from the offline queue while pending upload. `undefined` = loading,
// `null` = unavailable. `withStats` also fetches the `stats` sidecar (incl. raw HR);
// the map-only preview leaves it false.
export function useRouteTrace(run: Run, opts?: { withStats?: boolean }): { route: RouteData } {
  const withStats = opts?.withStats ?? false;
  // A GPS trace lives on routeId; an HR-only sidecar (no GPS) on hrRouteId. Both
  // are run_routes rows, so either resolves the same {points, stats} shape —
  // points is simply empty for an HR-only row (RunDetailModal renders the HR
  // chart/zones; History never mounts this hook for an hrRouteId-only run).
  const traceId = run.routeId ?? run.hrRouteId;
  const [route, setRoute] = useState<RouteData>(() => traceId ? undefined : getPendingRoute(run.routeTmp) as RouteData);
  useEffect(() => {
    if (!traceId) return; // pending route already pulled from localStorage
    let on = true;
    getRoute(traceId, withStats).then(r => on && setRoute(r as RouteData)).catch(() => on && setRoute(null));
    return () => { on = false; };
  }, [traceId, withStats]);
  return { route };
}
