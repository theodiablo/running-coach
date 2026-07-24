// Access module for saved favourite loops (route-finder Phase 4). Direct
// Supabase queries against the `saved_routes` table — NOT the app_state blob and
// NOT run_routes — mirroring src/routes.ts. A saved loop is PLANNED geometry to
// reuse; it is deliberately kept apart from recorded run traces so the two can
// never be confused. Best-effort by design: read failures resolve to [] and the
// finder simply shows no favourites, never blocking the tracker.

import { supabase } from "./supabase";
import { currentUserId } from "./db";
import type { SuggestedRoute } from "./types";

export type SavedRoute = SuggestedRoute & { label?: string; createdAt?: string };

type SavedRow = {
  id: string;
  label: string | null;
  points: SuggestedRoute["points"];
  km: number | null;
  elevation: number | null;
  created_at: string;
};

function rowToSaved(r: SavedRow): SavedRoute {
  return {
    id: r.id,
    label: r.label ?? undefined,
    points: Array.isArray(r.points) ? r.points : [],
    km: Number(r.km) || 0,
    elevation: Number(r.elevation) || 0,
    createdAt: r.created_at,
  };
}

// Newest-first list of the signed-in user's saved loops (best-effort).
export async function listSavedRoutes(): Promise<SavedRoute[]> {
  const { data, error } = await supabase
    .from("saved_routes")
    .select("id, label, points, km, elevation, created_at")
    .order("created_at", { ascending: false });
  if (error) { console.error("saved routes load failed", error); return []; }
  return (data as SavedRow[] | null)?.map(rowToSaved) ?? [];
}

// Star a suggested loop for reuse. Returns the new saved row, or null on failure
// (offline / not signed in) so the caller can surface a toast without throwing.
export async function saveRoute(route: SuggestedRoute, label?: string): Promise<SavedRoute | null> {
  const user_id = currentUserId();
  if (!user_id) return null;
  const { data, error } = await supabase
    .from("saved_routes")
    .insert({ user_id, label: label ?? null, points: route.points, km: route.km, elevation: route.elevation })
    .select("id, label, points, km, elevation, created_at")
    .single();
  if (error) { console.error("save route failed", error); return null; }
  return rowToSaved(data as SavedRow);
}

// Remove a saved loop. Best-effort — failure is logged, not thrown.
export async function deleteSavedRoute(id: string): Promise<boolean> {
  const { error } = await supabase.from("saved_routes").delete().eq("id", id);
  if (error) { console.error("delete saved route failed", error); return false; }
  return true;
}
