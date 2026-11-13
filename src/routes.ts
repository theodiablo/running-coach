import { supabase } from "./supabase";
import { currentUserId } from "./db";
import type { RouteBackup } from "./types";
import type { TrackPointOrGap } from "./utils/geo";

export type RoutePoint = TrackPointOrGap;
export type RouteStats = Record<string, unknown>;
export type RouteTrace = { points: RoutePoint[]; stats?: RouteStats };
type StoredRoute = RouteTrace & { id: string };
type PendingRoute = RouteTrace & { tmpId: string };
type BackupRoute = RouteBackup & { id?: unknown; points?: unknown; stats?: unknown };

// GPS route traces live in their own `run_routes` table, NOT the app_state blob:
// a polyline is heavy and the blob is re-upserted whole on every change, so
// keeping traces separate keeps the blob small. A run in rc_runs holds only a
// summary + `routeId` reference; the trace is fetched lazily for replay.

export async function saveRoute({ points, stats }: RouteTrace): Promise<string> {
  const user_id = currentUserId();
  if (!user_id) throw new Error("Not signed in");
  const { data, error } = await supabase
    .from("run_routes")
    .insert({ user_id, points, stats: stats || {} })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

// Lazy-fetch a trace for replay. Returns {points, stats} or null. `stats` carries the
// full ~1Hz HR stream (hundreds of KB on long runs), so map-only surfaces pass
// `withStats:false`; RunDetailModal passes true for the HR series/zones.
export async function getRoute(id: string, withStats = true): Promise<RouteTrace | null> {
  const { data, error } = await supabase
    .from("run_routes")
    .select(withStats ? "points, stats" : "points")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as RouteTrace | null;
}

// Recent recorded-route geometries (points only, no heavy stats), newest-first —
// for the route-finder's "somewhere new" comparison (Phase 3). The overlap check
// runs client-side so coordinates never leave the device. Best-effort: an error
// resolves to [] and the finder simply skips the novelty penalty.
export async function getRecentRoutePoints(limit = 20): Promise<RoutePoint[][]> {
  const { data, error } = await supabase
    .from("run_routes")
    .select("points")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) { console.error("recent routes load failed", error); return []; }
  return (data || []).map(r => (Array.isArray(r.points) ? (r.points as RoutePoint[]) : []));
}

// Best-effort delete (called when its run is deleted). Failure is logged, not
// thrown — the run removal must still succeed.
export async function deleteRoute(id?: string | null) {
  if (!id) return;
  const { error } = await supabase.from("run_routes").delete().eq("id", id);
  if (error) console.error("route delete failed", error);
}

// All traces for the signed-in user — used to include routes in a backup.
export async function getAllRoutes(): Promise<StoredRoute[]> {
  const { data, error } = await supabase.from("run_routes").select("id, points, stats");
  if (error) { console.error("routes load failed", error); return []; }
  return data || [];
}

// Re-insert traces from a backup, preserving their ids so run→route links hold.
export async function restoreRoutes(routes?: BackupRoute[] | null) {
  const user_id = currentUserId();
  if (!user_id || !routes?.length) return;
  const rows = routes
    .filter((r): r is BackupRoute & { id: string } => typeof r.id === "string")
    .map(r => ({ id: r.id, user_id, points: r.points, stats: r.stats || {} }));
  if (!rows.length) return;
  const { error } = await supabase.from("run_routes").upsert(rows);
  if (error) console.error("routes restore failed", error);
}

// ── Offline-resilient saves ──
// saveRoute on Stop can fail with poor signal: queue the trace in localStorage under
// a temporary id (stored on the run as `routeTmp`), flush on next load/connectivity,
// then patch the run with its real routeId.
const PENDING_KEY = "rc_pending_routes";

function loadPending(): PendingRoute[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? JSON.parse(raw) : [];
  }
  catch { return []; }
}
function savePending(list: PendingRoute[]) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch { /* quota */ }
}

export function queuePendingRoute(entry: PendingRoute) {
  const list = loadPending();
  list.push(entry);
  savePending(list);
}

// Drop a queued trace whose run was deleted before it ever synced, so it isn't
// later uploaded as an orphaned row (the privacy delete must cover pending
// traces too, not just already-synced ones).
export function removePendingRoute(tmpId?: string | null) {
  if (!tmpId) return;
  const list = loadPending();
  const next = list.filter(e => e.tmpId !== tmpId);
  if (next.length !== list.length) savePending(next);
}

// Read a not-yet-uploaded trace straight from the offline queue, so a run whose
// route is still pending sync can be viewed locally before it reaches Supabase.
export function getPendingRoute(tmpId?: string | null) {
  if (!tmpId) return null;
  return loadPending().find(e => e.tmpId === tmpId) || null;
}

// Retry every queued trace; onSaved(tmpId, routeId) relinks each success, failures stay queued.
// One flush at a time (boot and every `online` call this), or a trace uploads twice. The queue is
// re-read after each upload, never overwritten from a snapshot, so a trace queued or deleted
// meanwhile is kept or dropped as asked.
let flushingRoutes: Promise<void> | null = null;
export function flushPendingRoutes(onSaved?: (tmpId: string, routeId: string) => void): Promise<void> {
  if (!flushingRoutes) {
    flushingRoutes = flushRoutesOnce(onSaved).finally(() => { flushingRoutes = null; });
  }
  return flushingRoutes;
}

async function flushRoutesOnce(onSaved?: (tmpId: string, routeId: string) => void) {
  const queued = (tmpId: string) => loadPending().some(e => e.tmpId === tmpId);
  for (const e of loadPending()) {
    if (!queued(e.tmpId)) continue;
    let id: string;
    try {
      id = await saveRoute({ points: e.points, stats: e.stats });
    } catch {
      continue;
    }
    if (!queued(e.tmpId)) { void deleteRoute(id); continue; } // its run was deleted mid-upload
    savePending(loadPending().filter(x => x.tmpId !== e.tmpId));
    onSaved?.(e.tmpId, id);
  }
}
