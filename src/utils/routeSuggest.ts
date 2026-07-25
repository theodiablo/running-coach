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

// ── Candidate quality (Phase 2) ─────────────────────────────────────────────
// One generation = ONE charged edge-function call. We ask for several candidates
// (each at a different target length — the server brackets the distance to fight
// ORS's round-trip overshoot) and keep the ones closest to what was asked, rather
// than a second, separately-charged retry — so the per-user daily limit means
// what it says. A poor area is handled by the explicit "Regenerate".
const CANDIDATES_PER_GEN = 5;
const OVERLAP_THRESHOLD_M = 20; // two points closer than this (and far apart in the
const OVERLAP_MIN_IDX_GAP = 4;  //   path) count as an overlap

// ORS `surface` extra_info codes (the foot profiles reject `waytypes`). Natural
// / unpaved surfaces read as "paths" for a runner; hard paving as "streets".
// Unknown (0) and anything unlisted carries no signal.
const UNPAVED_SURFACES = new Set([2, 7, 8, 9, 10, 11, 12, 15, 16, 17, 18]); // unpaved, wood, gravels, dirt, ground, sand, woodchips, grass(-paver)
const PAVED_SURFACES = new Set([1, 3, 4, 5, 6, 14]);                        // paved, asphalt, concrete, cobblestone, metal, paving stones

// ── Proximity index ─────────────────────────────────────────────────────────
// Both overlap scores ask the same question — "is any other point within
// `thresholdM` of this one?" — and both used to answer it by scanning every
// other point. On a 20 km loop that is tens of thousands of haversine calls per
// candidate (tens of ms each, several candidates, all on the main thread right
// after the network wait), and the bbox prefilter can't help when the recorded
// history sits exactly where the candidates are, which is the normal case.
//
// So bucket the points into a grid of ~thresholdM cells: anything within the
// threshold of a point must lie in that point's own cell or one of the eight
// around it, so only those need testing. Results are IDENTICAL to the full
// scan (same threshold, same haversine) — it just skips pairs that could never
// have qualified. Pinned by a brute-force equivalence test.
type PointLike = [number, number, number | null];

const M_PER_DEG_LAT = 111320;

class ProximityGrid {
  private cells = new Map<string, number[]>();
  private dLat: number;
  private dLng: number;
  constructor(private points: PointLike[], cellM: number) {
    this.dLat = cellM / M_PER_DEG_LAT;
    // Longitude degrees shrink with latitude; size the cell at the set's own
    // latitude so cells stay >= cellM wide (never narrower, which would let a
    // qualifying neighbour fall outside the 3x3 window).
    const lat0 = points.length ? points[0][0] : 0;
    const cosLat = Math.max(0.01, Math.abs(Math.cos(lat0 * (Math.PI / 180))));
    this.dLng = cellM / (M_PER_DEG_LAT * cosLat);
    points.forEach((p, i) => {
      const key = this.key(p[0], p[1]);
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(i); else this.cells.set(key, [i]);
    });
  }
  private key(lat: number, lng: number): string {
    return Math.floor(lat / this.dLat) + "," + Math.floor(lng / this.dLng);
  }
  // Indices of every point in the 3x3 cell block around `p` — a superset of the
  // points within the threshold, which the caller still distance-tests.
  near(p: PointLike): number[] {
    const row = Math.floor(p[0] / this.dLat), col = Math.floor(p[1] / this.dLng);
    const out: number[] = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const bucket = this.cells.get((row + dr) + "," + (col + dc));
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }
}

// ── Pure geometry helpers (tested) ──────────────────────────────────────────

// One-line character bucket from an ORS `extras.surface.summary` array
// ([{ value, amount }], amount = % of the route on that surface). Returns an
// i18n key suffix, or undefined when there isn't enough tagged surface to say
// (OSM surface tagging is sparse — a route that's mostly "unknown" gets no
// label rather than a misleading one).
export function characterFromSurface(summary: unknown): string | undefined {
  if (!Array.isArray(summary)) return undefined;
  let unpaved = 0, paved = 0;
  for (const row of summary) {
    if (row && typeof row === "object") {
      const value = Number((row as { value?: unknown }).value);
      const amount = Number((row as { amount?: unknown }).amount);
      if (!Number.isFinite(value) || !Number.isFinite(amount)) continue;
      if (UNPAVED_SURFACES.has(value)) unpaved += amount;
      else if (PAVED_SURFACES.has(value)) paved += amount;
    }
  }
  const known = unpaved + paved;
  if (known < 40) return undefined; // too little surface data tagged to classify
  const unpavedRatio = unpaved / known;
  if (unpavedRatio >= 0.55) return "mostlyPaths";
  if (unpavedRatio >= 0.25) return "mixed";
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
  const grid = new ProximityGrid(points, thresholdM);
  for (let i = 0; i < n; i++) {
    // Same pair set as a full j < i - gap scan: any j within thresholdM is in
    // the 3x3 block, and the index/closure filters below are unchanged.
    for (const j of grid.near(points[i])) {
      if (j >= i - OVERLAP_MIN_IDX_GAP) continue;
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
  // Index the history once, then each candidate point only tests the recorded
  // points in its own neighbourhood — the case the bbox prefilter can't help
  // with is precisely when history and candidates overlap, which is here.
  const grid = new ProximityGrid(history, thresholdM);
  for (const p of points) {
    for (const j of grid.near(p)) {
      if (haversineM(p, history[j]) < thresholdM) { near++; break; }
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
    const surface = extras && typeof extras === "object" ? (extras as { surface?: unknown }).surface : null;
    const sSummary = surface && typeof surface === "object" ? (surface as { summary?: unknown }).summary : null;
    out.push({
      id: "sr" + (seedBase + i),
      points: simplified,
      km,
      elevation,
      character: characterFromSurface(sSummary),
      overlapPct: +selfOverlapPct(simplified).toFixed(3),
    });
  });
  return out;
}

// Soft elevation-preference penalty (0 = ideal for the ask, ~1 = worst) from a
// candidate's metres-of-gain-per-km. `flat` favours the flattest loops, `hilly`
// the hilliest; `rolling`/unset is neutral. This only NUDGES ordering — it never
// drops a candidate — so the finder still returns three loops in flat terrain.
// perKm is normalised against ~30 m/km (a firmly hilly loop) → clamped to [0,1].
function elevationPenalty(route: SuggestedRoute, elevation?: ElevationPref): number {
  if (!elevation || elevation === "rolling" || route.km <= 0) return 0;
  const perKm = Math.min(route.elevation / route.km / 30, 1);
  return elevation === "flat" ? perKm : 1 - perKm; // hilly wants MORE gain
}

// Annotate each candidate with its length error and return them best-first
// (closest to target, least overlap, elevation nearest the requested terrain).
// Never drops any — the worst still shows if nothing better exists, with honest
// measured numbers.
export function rankCandidates(routes: SuggestedRoute[], targetKm: number, elevation?: ElevationPref): SuggestedRoute[] {
  const scored = routes.map(r => ({
    r: { ...r, lengthErrorPct: targetKm > 0 ? +(Math.abs(r.km - targetKm) / targetKm).toFixed(3) : undefined },
    cost: (targetKm > 0 ? Math.abs(r.km - targetKm) / targetKm : 0)
      + (r.overlapPct ?? 0) * 0.5
      + elevationPenalty(r, elevation) * 0.35,
  }));
  scored.sort((a, b) => a.cost - b.cost);
  return scored.map(s => s.r);
}

// ── Edge-function call (never throws) ───────────────────────────────────────

// The generation outcome, kept distinct so the sheet can show the RIGHT message
// instead of collapsing everything into "couldn't fetch":
//   ok              — at least one routable loop
//   empty           — the server answered fine but found no loop here
//   rateLimited     — the per-user daily cap is spent
//   premiumRequired — the server says this account isn't premium
//   error           — transport failure / feature unconfigured / offline
export type RouteSuggestResult =
  | { status: "ok"; routes: SuggestedRoute[] }
  | { status: "empty" }
  | { status: "rateLimited" }
  | { status: "premiumRequired" }
  | { status: "error" };

type FetchOutcome =
  | { kind: "features"; features: unknown[] }
  | { kind: "rateLimited" }
  | { kind: "premiumRequired" }
  | { kind: "error" };

// One generation call to the proxy. Never throws. Distinguishes the rate-limit
// reply (200 with code:"RATE_LIMIT") from an unconfigured/transport error and
// from a successful-but-empty feature list.
async function fetchFeatures(params: RouteSuggestParams, seedBase: number, count: number): Promise<FetchOutcome> {
  try {
    const { data, error } = await supabase.functions.invoke("route-suggest", {
      body: { ...params, seedBase, count },
    });
    if (error) return { kind: "error" };
    // Both coded replies carry an `error` string too, so they MUST be matched
    // before the generic error branch below or they'd collapse into "couldn't
    // fetch" and lose their specific message.
    if (data?.code === "RATE_LIMIT") return { kind: "rateLimited" };
    if (data?.code === "PREMIUM_REQUIRED") return { kind: "premiumRequired" };
    if (!data || data.configured === false || data.error) return { kind: "error" };
    return { kind: "features", features: Array.isArray(data.features) ? data.features : [] };
  } catch {
    return { kind: "error" };
  }
}

// Fetch and score one generation. Exactly ONE edge-function call (one charged
// unit) — we request several candidates and return the best rather than a
// second, separately-charged retry, so the daily limit is honest. `seedBase`
// lets the sheet's "Regenerate" ask for a fresh batch (its own explicit,
// single-call generation). The typed result lets the caller tell "capped" and
// "nothing here" apart from "fetch failed"; the tracker stays fully usable
// regardless.
export async function routeSuggest(params: RouteSuggestParams, opts: { seedBase?: number } = {}): Promise<RouteSuggestResult> {
  if (!routeSuggestEnabled) return { status: "error" };
  if (!Number.isFinite(params.lat) || !Number.isFinite(params.lng) || !(params.km > 0)) return { status: "error" };
  const seedBase = opts.seedBase ?? 0;
  const outcome = await fetchFeatures(params, seedBase, CANDIDATES_PER_GEN);
  if (outcome.kind === "rateLimited") return { status: "rateLimited" };
  // Normally unreachable (the sheet only opens for premium users), but real:
  // an entitlement can lapse or be revoked mid-session, or another device can
  // hold staler state. Surfaced rather than swallowed as a generic failure.
  if (outcome.kind === "premiumRequired") return { status: "premiumRequired" };
  if (outcome.kind === "error") return { status: "error" };
  const all = parseLoopCandidates(outcome.features, seedBase);
  if (!all.length) return { status: "empty" };
  // Always surface the three CLOSEST-to-target loops (the server's length spread
  // is centred so these cluster near the ask). We deliberately don't hard-filter
  // by tolerance here — that made the count flap between 1 and 3; the spread
  // keeps the three closest accurate instead.
  const routes = rankCandidates(all, params.km, params.elevation).slice(0, 3);
  return { status: "ok", routes };
}
