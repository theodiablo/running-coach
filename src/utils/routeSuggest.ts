// Client access module + pure helpers for the "Find a route" loop finder.
//
// Mirrors src/utils/geocode.ts exactly: config-guarded, a plain functions.invoke
// against the route-suggest edge function, and it NEVER throws — routeSuggest()
// resolves null when the feature is off, offline, rate-limited, or produced no
// usable loop, so the tracker is never blocked. All decoding/measuring/scoring
// is pure and unit-tested (parseLoopCandidates, selfOverlapPct, rankCandidates),
// and every displayed number comes from the SAME geo utils the tracker records
// with (distanceKm/elevGainM), so a suggested route can't read differently from
// the run once it's logged.

import { supabase } from "../supabase";
import { routeSuggestEnabled } from "../constants";
import { distanceKm, elevGainM, haversineM, simplify } from "./geo";
import type { SuggestedRoute } from "../types";
import type { TrackPointOrGap } from "./geo";

export type ElevationPref = "flat" | "rolling" | "hilly";
export type RouteSuggestParams = { lat: number; lng: number; km: number; elevation?: ElevationPref };

// ── Candidate quality thresholds (Phase 2) ──────────────────────────────────
const MAX_LENGTH_ERROR = 0.2;   // reject loops >20% off the requested distance
const MAX_OVERLAP = 0.4;        // reject loops that double back over themselves
// One generation = ONE charged edge-function call. We ask for a few candidates
// up front and pick the best rather than a second, separately-charged retry —
// so the per-user daily limit means what it says. A poor area is handled by the
// explicit (also single-call) "Regenerate", not a silent double charge.
const CANDIDATES_PER_GEN = 4;
const OVERLAP_THRESHOLD_M = 20; // two points closer than this (and far apart in the
const OVERLAP_MIN_IDX_GAP = 4;  //   path) count as an overlap

// ORS WayType codes that read as "off-road / pedestrian" for the character line:
// 4=Path, 5=Track, 7=Footway, 8=Steps. (State roads/streets are the rest.)
const PATH_WAYTYPES = new Set([4, 5, 7, 8]);

// ── Pure geometry helpers (tested) ──────────────────────────────────────────

// One-line character bucket from an ORS `extras.waytypes.summary` array
// ([{ value, amount }], amount = % of the route on that way type). Returns an
// i18n key suffix, or undefined when way-type data is absent.
export function characterFromWaytypes(summary: unknown): string | undefined {
  if (!Array.isArray(summary)) return undefined;
  let pathShare = 0;
  for (const row of summary) {
    if (row && typeof row === "object") {
      const value = Number((row as { value?: unknown }).value);
      const amount = Number((row as { amount?: unknown }).amount);
      if (Number.isFinite(value) && Number.isFinite(amount) && PATH_WAYTYPES.has(value)) pathShare += amount;
    }
  }
  if (pathShare >= 55) return "mostlyPaths";
  if (pathShare >= 25) return "mixed";
  return "mostlyStreets";
}

// Fraction of a loop's points that lie on top of an earlier, non-adjacent stretch
// (an out-and-back). The natural start↔finish closure is excluded so a clean loop
// scores ~0. Points are [lat,lng,...] tuples.
export function selfOverlapPct(points: [number, number, number | null][], thresholdM = OVERLAP_THRESHOLD_M): number {
  const n = points.length;
  if (n < 8) return 0;
  const nearStart = Math.max(2, Math.floor(n * 0.1));
  const nearEnd = n - nearStart;
  // Flag BOTH points of every overlapping pair, so a pure out-and-back (where the
  // return path retraces the outbound one) flags almost every point and scores
  // near 1 — flagging only the later point would cap it at ~0.5.
  const overlapped = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i - OVERLAP_MIN_IDX_GAP; j++) {
      // Skip the loop-closure: a finish point near a start point is expected.
      if (i >= nearEnd && j <= nearStart) continue;
      if (haversineM(points[i], points[j]) < thresholdM) { overlapped[i] = overlapped[j] = true; }
    }
  }
  return overlapped.filter(Boolean).length / n;
}

// Fraction of a candidate loop's points that lie within `thresholdM` of ANY point
// on the user's recorded routes (Phase 3 "somewhere new"). Pure; every coordinate
// stays on-device. `history` is a flat list of [lat,lng,...] tuples (null gaps
// skipped by the caller). 0 = all-new ground, 1 = fully retreads old routes.
export function overlapWithHistory(
  points: [number, number, number | null][],
  history: [number, number, number | null][],
  thresholdM = 25,
): number {
  if (!points.length || !history.length) return 0;
  let near = 0;
  for (const p of points) {
    for (const h of history) {
      if (haversineM(p, h) < thresholdM) { near++; break; }
    }
  }
  return near / points.length;
}

// Cheap O(history) pre-pass for "somewhere new": keep only recorded-route points
// inside the candidates' combined bounding box (padded by ~marginM), so the
// O(points × history) overlap scan never touches routes in another part of town.
// Pure; coordinates stay on-device.
export function historyNearCandidates(
  history: [number, number, number | null][],
  candidates: { points: [number, number, number | null][] }[],
  marginM = 100,
): [number, number, number | null][] {
  const pts = candidates.flatMap(c => c.points);
  if (!pts.length || !history.length) return [];
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of pts) {
    if (p[0] < minLat) minLat = p[0];
    if (p[0] > maxLat) maxLat = p[0];
    if (p[1] < minLng) minLng = p[1];
    if (p[1] > maxLng) maxLng = p[1];
  }
  const dLat = marginM / 111320;
  const dLng = marginM / (111320 * Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180)) || 1);
  return history.filter(h => h[0] >= minLat - dLat && h[0] <= maxLat + dLat && h[1] >= minLng - dLng && h[1] <= maxLng + dLng);
}

// Decode a batch of ORS GeoJSON round-trip features into measured SuggestedRoutes.
// Pure: no I/O. `seedBase` only seeds the local ids so a batch has stable keys.
export function parseLoopCandidates(features: unknown, seedBase = 0): SuggestedRoute[] {
  if (!Array.isArray(features)) return [];
  const out: SuggestedRoute[] = [];
  features.forEach((feature, i) => {
    const geometry = feature && typeof feature === "object" ? (feature as { geometry?: unknown }).geometry : null;
    const coords = geometry && typeof geometry === "object" ? (geometry as { coordinates?: unknown }).coordinates : null;
    if (!Array.isArray(coords) || coords.length < 2) return;
    // ORS coordinates are [lng, lat, ele]; store [lat, lng, ele|null].
    const points: [number, number, number | null][] = [];
    for (const c of coords) {
      if (!Array.isArray(c) || c.length < 2) continue;
      const lng = Number(c[0]), lat = Number(c[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const ele = c.length > 2 && Number.isFinite(Number(c[2])) ? Number(c[2]) : null;
      points.push([lat, lng, ele]);
    }
    if (points.length < 2) return;
    // Distance: ORS geometry is CLEAN and densely sampled along curves, so the
    // tracker's 3m jitter gate (built for noisy GPS) would drop legitimate short
    // legs and undercount the loop — measure the true polyline length with the
    // gate OFF (minM=0). Elevation KEEPS elevGainM's 5m hysteresis: the SRTM data
    // ORS samples is noisier than 5m, so a smaller band would inflate the gain.
    const km = +distanceKm(points as unknown as TrackPointOrGap[], 0).toFixed(2);
    const elevation = Math.round(elevGainM(points.map(p => ({ lat: p[0], lng: p[1], alt: p[2] }))));
    // Simplify FIRST, then score self-overlap on the thinned line: selfOverlapPct
    // is O(n^2), and a dense raw ORS loop can be thousands of points, so scoring
    // the simplified (tens of points) geometry keeps it off the main-thread hot path.
    const simplified = simplify(points as unknown as TrackPointOrGap[]) as [number, number, number | null][];
    const props = feature && typeof feature === "object" ? (feature as { properties?: unknown }).properties : null;
    const extras = props && typeof props === "object" ? (props as { extras?: unknown }).extras : null;
    const waytypes = extras && typeof extras === "object" ? (extras as { waytypes?: unknown }).waytypes : null;
    const wtSummary = waytypes && typeof waytypes === "object" ? (waytypes as { summary?: unknown }).summary : null;
    out.push({
      id: "sr" + (seedBase + i),
      points: simplified,
      km,
      elevation,
      character: characterFromWaytypes(wtSummary),
      overlapPct: +selfOverlapPct(simplified).toFixed(3),
    });
  });
  return out;
}

// Whether a candidate's elevation profile matches the requested preference
// (metres of gain per km). Loose bounds — this only nudges ordering / retries.
function elevationOK(route: SuggestedRoute, elevation?: ElevationPref): boolean {
  if (!elevation || elevation === "rolling" || route.km <= 0) return true;
  const perKm = route.elevation / route.km;
  if (elevation === "flat") return perKm <= 15;
  return perKm >= 8; // hilly
}

// Is a candidate good enough to stop retrying? (Length within tolerance, not a
// heavy out-and-back, elevation in the requested band.)
export function acceptable(route: SuggestedRoute, targetKm: number, elevation?: ElevationPref): boolean {
  const err = targetKm > 0 ? Math.abs(route.km - targetKm) / targetKm : 1;
  return err <= MAX_LENGTH_ERROR && (route.overlapPct ?? 0) <= MAX_OVERLAP && elevationOK(route, elevation);
}

// Annotate each candidate with its length error and return them best-first
// (closest to target + least overlap). Never drops any — the worst still shows
// if nothing better exists, with honest measured numbers.
export function rankCandidates(routes: SuggestedRoute[], targetKm: number): SuggestedRoute[] {
  const scored = routes.map(r => ({
    r: { ...r, lengthErrorPct: targetKm > 0 ? +(Math.abs(r.km - targetKm) / targetKm).toFixed(3) : undefined },
    cost: (targetKm > 0 ? Math.abs(r.km - targetKm) / targetKm : 0) + (r.overlapPct ?? 0) * 0.5,
  }));
  scored.sort((a, b) => a.cost - b.cost);
  return scored.map(s => s.r);
}

// ── Edge-function call (never throws) ───────────────────────────────────────

// One generation call to the proxy. Returns the raw feature array, or null when
// the feature is off / unconfigured / rate-limited / a transport failure (the
// caller shows a toast either way). An empty array means the seeds all failed.
async function fetchFeatures(params: RouteSuggestParams, seedBase: number, count: number): Promise<unknown[] | null> {
  try {
    const { data, error } = await supabase.functions.invoke("route-suggest", {
      body: { ...params, seedBase, count },
    });
    if (error) return null;
    if (!data || data.configured === false || data.error) return null;
    return Array.isArray(data.features) ? data.features : [];
  } catch {
    return null;
  }
}

// Fetch and score one generation. Exactly ONE edge-function call (one charged
// unit) — we request several candidates and return the best rather than a
// second, separately-charged retry, so the daily limit is honest. `seedBase`
// lets the sheet's "Regenerate" ask for a fresh batch (its own explicit,
// single-call generation). Resolves null when nothing usable came back, so the
// caller shows a toast and the tracker stays fully usable.
export async function routeSuggest(params: RouteSuggestParams, opts: { seedBase?: number } = {}): Promise<SuggestedRoute[] | null> {
  if (!routeSuggestEnabled) return null;
  if (!Number.isFinite(params.lat) || !Number.isFinite(params.lng) || !(params.km > 0)) return null;
  const seedBase = opts.seedBase ?? 0;
  const features = await fetchFeatures(params, seedBase, CANDIDATES_PER_GEN);
  if (features == null) return null;
  const all = parseLoopCandidates(features, seedBase);
  if (!all.length) return null;
  return rankCandidates(all, params.km).slice(0, 3);
}
