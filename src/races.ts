import { supabase } from "./supabase";
import { currentUserId } from "./db";
import { notifyContribution } from "./notify";
import type { CatalogueEdition, CatalogueRace } from "./types";
import { raceUrl } from "./utils/raceForm";

export { raceUrl };

type RaceRow = {
  slug: string;
  name: string;
  city?: string | null;
  country?: string | null;
  lat?: number | null;
  lng?: number | null;
  distances?: number[] | null;
  url?: string | null;
  verified?: boolean;
  created_by?: string | null;
  terrain?: string | null;
};

type EditionRow = {
  id: string;
  race_slug: string;
  date: string;
  distance_km: number;
  elevation?: number | null;
  verified?: boolean;
  created_by?: string | null;
};

type AddRaceInput = {
  name?: string;
  city?: string | null;
  country?: string | null;
  lat?: number | null;
  lng?: number | null;
  distances?: number[];
  url?: string | null;
  terrain?: RaceTerrain | null;
  distinctFrom?: string[];
};

type AddEditionInput = { raceSlug: string; date: string; distanceKm: number; elevation?: number };
type ReportRaceInput = { raceSlug?: string | null; editionId?: string | null; reason: string; note?: string | null };

// Shared race catalogue access (Phase 2). Mirrors src/routes.ts: direct supabase queries,
// owner-scoped writes, failure-tolerant reads. The app imports catalogue lookups via
// src/utils/races.ts, which caches the account's own races from listKnownRaces(). Personal data (participations)
// stays in the app_state blob.

// Map a DB race row + its editions to the joined shape the app already uses
// (the old CURATED_RACES shape): camelCase, id === slug, editions newest-first.
function toRace(row: RaceRow, editions: EditionRow[] = []): CatalogueRace {
  return {
    id: row.slug,
    slug: row.slug,
    name: row.name,
    city: row.city,
    country: row.country,
    lat: row.lat,
    lng: row.lng,
    distances: row.distances || [],
    url: raceUrl(row.url),
    verified: row.verified,
    createdBy: row.created_by,
    terrain: row.terrain === "road" || row.terrain === "trail" ? row.terrain : null,
    editions: (editions || [])
      .map((e): CatalogueEdition => ({
        id: e.id,
        date: e.date,
        distanceKm: e.distance_km,
        elevation: e.elevation || 0,
        verified: e.verified,
        createdBy: e.created_by,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

const RACE_COLS = "slug, name, city, country, lat, lng, distances, url, verified, created_by, terrain";
const EDITION_COLS = "id, race_slug, date, distance_km, elevation, verified, created_by";

// The races this account needs offline (src/utils/races.ts caches them): the editions it planned
// around plus its own contributions (races, and dates added to anyone's race). Failure-tolerant: [] on error, callers keep their snapshots.
export async function listKnownRaces({ editionIds = [], userId = null }: { editionIds?: string[]; userId?: string | null }): Promise<CatalogueRace[]> {
  const ids = [...new Set(editionIds.filter(Boolean))];
  const none = { data: [] as { race_slug: string }[], error: null };
  const [edsRes, mineRes, myEdsRes] = await Promise.all([
    ids.length ? supabase.from("race_editions").select("race_slug").in("id", ids) : Promise.resolve(none),
    userId ? supabase.from("races").select("slug").eq("created_by", userId) : Promise.resolve({ data: [] as { slug: string }[], error: null }),
    userId ? supabase.from("race_editions").select("race_slug").eq("created_by", userId) : Promise.resolve(none),
  ]);
  const failed = edsRes.error || mineRes.error || myEdsRes.error;
  if (failed) { console.error("known races load failed", failed); return []; }
  const slugs = [...new Set([
    ...(edsRes.data || []).map(e => e.race_slug), ...(mineRes.data || []).map(r => r.slug), ...(myEdsRes.data || []).map(e => e.race_slug),
  ])];
  if (!slugs.length) return [];
  const [racesRes, allEdsRes] = await Promise.all([
    supabase.from("races").select(RACE_COLS).in("slug", slugs),
    supabase.from("race_editions").select(EDITION_COLS).in("race_slug", slugs),
  ]);
  if (racesRes.error || allEdsRes.error) { console.error("known races load failed", racesRes.error || allEdsRes.error); return []; }
  const byRace: Record<string, EditionRow[]> = {};
  for (const e of allEdsRes.data || []) (byRace[e.race_slug] ||= []).push(e);
  return (racesRes.data || []).map(r => toRace(r, byRace[r.slug]));
}

export type RaceTerrain = "road" | "trail";
export type RaceSearchParams = {
  query?: string;
  minKm?: number | null;
  maxKm?: number | null;
  from?: string | null;
  to?: string | null;
  countries?: string[];
  terrain?: RaceTerrain | null;
  verifiedOnly?: boolean;
  near?: { lat: number; lng: number } | null;
  radiusKm?: number | null;
  sort?: "date" | "distance";
  limit?: number;
};
export type RaceCursor = { key: number; slug: string };
export type RaceSearchPage = { races: CatalogueRace[]; next: RaceCursor | null; total: number | null };
type SearchRow = RaceRow & { editions?: EditionRow[] | null; dist_km?: number | null };

// ~1 km grid: Near me never sends a precise position (docs/races.md).
const coarse = (v: number) => Math.round(v * 100) / 100;

// Pages already fetched this session, so going back to a filter or the tab answers at once.
// Short-lived and memory-only: the catalogue changes weekly, a contribution clears it.
export const SEARCH_CACHE_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 50;
const searchCache = new Map<string, { at: number; page: RaceSearchPage }>();
const cacheKey = (params: RaceSearchParams, after: RaceCursor | null) => JSON.stringify([params, after]);

export function peekRaceSearch(params: RaceSearchParams, after: RaceCursor | null = null, now = Date.now()): RaceSearchPage | null {
  const hit = searchCache.get(cacheKey(params, after));
  return hit && now - hit.at < SEARCH_CACHE_MS ? hit.page : null;
}

// Bumped whenever the cache is dropped, so a mounted search asks again (a contribution shows at once).
let searchCacheVersion = 0;
export const raceSearchVersion = () => searchCacheVersion;

export function clearRaceSearchCache() {
  searchCache.clear();
  countriesCache = null;
  searchCacheVersion++;
}

// One page of the shared catalogue, filtered and sorted server-side (search_races). Throws on a
// failed call so the screen can offer a retry rather than read it as "no races".
export async function searchRaces(params: RaceSearchParams, after: RaceCursor | null = null): Promise<RaceSearchPage> {
  const cached = peekRaceSearch(params, after);
  if (cached) return cached;
  const { data, error } = await supabase.rpc("search_races", {
    p_query: params.query?.trim() || null,
    p_min_km: params.minKm ?? null,
    p_max_km: params.maxKm ?? null,
    p_from: params.from || null,
    p_to: params.to || null,
    p_countries: params.countries?.length ? params.countries : null,
    p_terrain: params.terrain || null,
    p_verified_only: !!params.verifiedOnly,
    p_lat: params.near ? coarse(params.near.lat) : null,
    p_lng: params.near ? coarse(params.near.lng) : null,
    p_radius_km: params.near ? params.radiusKm ?? null : null,
    p_sort: params.sort === "distance" && params.near ? "distance" : "date",
    p_after_key: after?.key ?? null,
    p_after_slug: after?.slug ?? null,
    p_limit: params.limit ?? 20,
  });
  if (error) throw error;
  const page = (data || {}) as { races?: SearchRow[]; next?: RaceCursor | null; total?: number | null };
  const result = {
    races: (page.races || []).map(r => ({ ...toRace(r, r.editions || []), distKm: r.dist_km ?? null })),
    next: page.next || null,
    total: page.total ?? null,
  };
  const key = cacheKey(params, after);
  searchCache.delete(key);
  searchCache.set(key, { at: Date.now(), page: result });
  while (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value as string);
  return result;
}

export type RaceCountry = { country: string; races: number };
let countriesCache: { at: number; list: RaceCountry[] } | null = null;

// Countries with an upcoming race and how many, most first; cached like a search page. [] on error:
// the filter just offers none, and the next open asks again.
export async function listRaceCountries(): Promise<RaceCountry[]> {
  if (countriesCache && Date.now() - countriesCache.at < SEARCH_CACHE_MS) return countriesCache.list;
  const { data, error } = await supabase.rpc("race_countries");
  if (error) { console.error("race countries load failed", error); return []; }
  const list = ((data || []) as RaceCountry[]).map(r => ({ country: r.country, races: Number(r.races) || 0 }));
  countriesCache = { at: Date.now(), list };
  return list;
}

export type RaceDuplicate = { race: CatalogueRace; strong: boolean; editionId: string | null };
export type RaceDuplicateQuery = {
  name?: string; country?: string | null; lat?: number | null; lng?: number | null;
  date?: string | null; distanceKm?: number | null;
};
type DuplicateRow = SearchRow & { strong?: boolean; edition_id?: string | null };

// Races the one being added may already be (race_duplicates), most likely first. `strong` means
// the form should ask before creating; `editionId` is the same race day, reusable as is.
export async function findRaceDuplicates(p: RaceDuplicateQuery, limit = 5): Promise<RaceDuplicate[]> {
  const { data, error } = await supabase.rpc("race_duplicates", {
    p_name: p.name?.trim() || null,
    p_country: p.country || null,
    p_lat: p.lat ?? null,
    p_lng: p.lng ?? null,
    p_date: p.date || null,
    p_distance_km: p.distanceKm || null,
    p_limit: limit,
  });
  if (error) throw error;
  return ((data || []) as DuplicateRow[]).map(r => ({
    race: { ...toRace(r, r.editions || []), distKm: r.dist_km ?? null },
    strong: !!r.strong,
    editionId: r.edition_id || null,
  }));
}

// The race_editions_reject_duplicate refusal (RC409): the race this edition repeats.
export function duplicateRefusal(err: unknown): { raceSlug: string; editionId: string | null } | null {
  const e = err as { code?: string; details?: string | null; hint?: string | null } | null;
  return e?.code === "RC409" && e.details ? { raceSlug: e.details, editionId: e.hint || null } : null;
}

// kebab-case a name into a slug (strip accents/punctuation, collapse to dashes).
function slugify(s: string) {
  return (s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const isUniqueViolation = (err: { code?: string } | null | undefined) => err?.code === "23505";

// Add a new race (always unverified, owned by the signed-in user). Generates a
// slug from the name, falling back to name-city if that slug is taken, so two
// different races with the same name don't collide. Returns the joined race.
export async function addRace({ name, city, country, lat, lng, distances, url, terrain, distinctFrom }: AddRaceInput) {
  const user_id = currentUserId();
  if (!user_id) throw new Error("Not signed in");
  const raceName = name || "";
  const base = slugify(raceName) || "race";
  const candidates = [base, slugify(`${raceName}-${city}`), `${base}-${Date.now().toString(36)}`];
  let lastErr: Error | { message?: string } | null = null;
  // Sent only when set, and dropped on PGRST204, so a save works before distinct_from's migration lands.
  let extra: { distinct_from?: string[] } = distinctFrom?.length ? { distinct_from: distinctFrom } : {};
  for (let i = 0; i < candidates.length; i++) {
    const slug = candidates[i];
    const { data, error } = await supabase
      .from("races")
      .insert({ slug, name: raceName, city, country, lat, lng, distances: distances || [], url: raceUrl(url), terrain: terrain || null, ...extra, verified: false, created_by: user_id })
      .select(RACE_COLS)
      .single();
    if (!error) { clearRaceSearchCache(); return toRace(data, []); }
    if (error.code === "PGRST204" && extra.distinct_from) { extra = {}; i--; continue; }
    if (!isUniqueViolation(error)) { lastErr = error; break; }
    lastErr = error; // slug taken — try the next candidate
  }
  throw lastErr || new Error("Could not add race");
}

// Best-effort rollback: delete a race we just created (RLS allows deleting only
// your own rows). Used when the follow-up addEdition fails, so a childless race
// never lingers in the shared catalogue. on-delete-cascade clears any editions.
export async function deleteRace(slug: string) {
  const { error } = await supabase.from("races").delete().eq("slug", slug);
  if (error) throw error;
}

// Add an edition (dated running) to an existing race. id is `slug-date`; if that
// is already taken (same race + date, different distance) the distance is
// appended so the unique(race_slug,date,distance_km) constraint still holds.
export async function addEdition({ raceSlug, date, distanceKm, elevation = 0 }: AddEditionInput) {
  const user_id = currentUserId();
  if (!user_id) throw new Error("Not signed in");
  const row = {
    race_slug: raceSlug, date, distance_km: distanceKm,
    elevation: elevation || 0, verified: false, created_by: user_id,
  };
  for (const id of [`${raceSlug}-${date}`, `${raceSlug}-${date}-${distanceKm}`]) {
    const { data, error } = await supabase
      .from("race_editions")
      .insert({ id, ...row })
      .select("id, race_slug, date, distance_km, elevation, verified")
      .single();
    if (!error) clearRaceSearchCache();
    if (!error) return { id: data.id, date: data.date, distanceKm: data.distance_km, elevation: data.elevation, verified: data.verified };
    if (!isUniqueViolation(error)) throw error;
  }
  throw new Error("Could not add edition");
}

// File a moderation report. Inserts WITHOUT a returning .select() — race_reports
// has no client SELECT policy, so reading back the row would 403 even though the
// write succeeds. Best-effort emails the maintainer via the edge function.
export async function reportRace({ raceSlug, editionId, reason, note }: ReportRaceInput) {
  const user_id = currentUserId();
  if (!user_id) throw new Error("Not signed in");
  const id = crypto.randomUUID();
  const { error } = await supabase
    .from("race_reports")
    .insert({ id, race_slug: raceSlug || null, edition_id: editionId || null, reason, note: note || null, reporter_id: user_id });
  if (error) throw error;
  notifyContribution({ type: "report", reportId: id });
}
