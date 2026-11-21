// Race catalogue filters: the one definition of the distance scale, what each filter sends to
// search_races, and the client-side edition match that mirrors it (docs/races.md).
import type { TFunction } from "i18next";
import type { RaceSearchParams, RaceTerrain } from "../races";
import type { CatalogueEdition, CatalogueRace } from "../types";
import { ymd } from "./format";

// Stops on the distance slider (km); the last one is open-ended ("100+").
export const DISTANCE_STOPS = [3, 5, 10, 15, 21.1, 30, 42.2, 60, 100] as const;
export const LAST_STOP = DISTANCE_STOPS.length - 1;
// Same tolerance as the server, so a 21 km race sits on the "Half" stop.
export const KM_TOLERANCE = 0.05;

export type DistanceRange = { min: number; max: number };
export const ANY_DISTANCE: DistanceRange = { min: 0, max: LAST_STOP };
export const RADII = [25, 50, 100, 500] as const;
export const MAX_COUNTRIES = 30;
export const WHEN_MONTHS = [1, 3, 6, 12] as const;

export type RaceFilters = {
  distance: DistanceRange;
  when: number | null;          // months ahead, or null for any date
  countries: string[];
  terrain: RaceTerrain | null;
  verifiedOnly: boolean;
  near: boolean;
  radius: number;
  sort: "date" | "distance";
};

export const DEFAULT_FILTERS: RaceFilters = {
  distance: ANY_DISTANCE, when: null, countries: [], terrain: null, verifiedOnly: false,
  near: false, radius: 100, sort: "date",
};

type Translate = TFunction;

export const isAnyDistance = (r: DistanceRange) => r.min <= 0 && r.max >= LAST_STOP;

// The label for one stop: the named race distances read as words, the rest as km.
export function stopLabel(t: Translate, i: number) {
  const km = DISTANCE_STOPS[i];
  if (i === LAST_STOP) return t("races.filters.stopOpen", { km });
  if (km === 5) return "5K";
  if (km === 10) return "10K";
  if (km === 21.1) return t("races.filters.stopHalf");
  if (km === 42.2) return t("races.filters.stopMarathon");
  return String(km);
}

export function rangeLabel(t: Translate, r: DistanceRange) {
  if (isAnyDistance(r)) return t("races.filters.anyDistance");
  if (r.min === r.max) return stopLabel(t, r.min);
  if (r.max >= LAST_STOP) return t("races.filters.andUp", { from: stopLabel(t, r.min) });
  if (r.min <= 0) return t("races.filters.upTo", { to: stopLabel(t, r.max) });
  return t("races.filters.between", { from: stopLabel(t, r.min), to: stopLabel(t, r.max) });
}

// A thumb dragged past the other one takes its place, so two stacked thumbs can always be pulled
// apart whichever of them sits on top.
export function dragThumb(r: DistanceRange, thumb: "min" | "max", v: number): DistanceRange {
  if (thumb === "min") return v <= r.max ? { min: v, max: r.max } : { min: r.max, max: v };
  return v >= r.min ? { min: r.min, max: v } : { min: v, max: r.min };
}

// The km bounds a range stands for; null is unbounded on that side.
export function rangeKm(r: DistanceRange): { minKm: number | null; maxKm: number | null } {
  return {
    minKm: r.min <= 0 ? null : DISTANCE_STOPS[r.min],
    maxKm: r.max >= LAST_STOP ? null : DISTANCE_STOPS[r.max],
  };
}

// The stop nearest a distance (the "My distance" shortcut).
export function nearestStop(km: number): number {
  let best = 0;
  DISTANCE_STOPS.forEach((s, i) => { if (Math.abs(s - km) < Math.abs(DISTANCE_STOPS[best] - km)) best = i; });
  return best;
}

export function kmInRange(km: number, r: DistanceRange): boolean {
  const { minKm, maxKm } = rangeKm(r);
  return (minKm == null || km >= minKm * (1 - KM_TOLERANCE)) && (maxKm == null || km <= maxKm * (1 + KM_TOLERANCE));
}

// Last day of the "when" window, `months` ahead of today.
export function whenUntil(months: number | null, today: Date = new Date()): string | null {
  if (!months) return null;
  const d = new Date(today.getFullYear(), today.getMonth() + months, today.getDate());
  return ymd(d);
}

// How many filters are set, for the "Filters · n" badge. Sort is not a filter.
export function activeFilterCount(f: RaceFilters): number {
  return (isAnyDistance(f.distance) ? 0 : 1) + (f.when ? 1 : 0) + (f.countries.length ? 1 : 0)
    + (f.terrain ? 1 : 0) + (f.verifiedOnly ? 1 : 0) + (f.near ? 1 : 0);
}

export function searchParams(query: string, f: RaceFilters, loc: { lat: number; lng: number } | null, today = new Date()): RaceSearchParams {
  const near = f.near && loc ? loc : null;
  return {
    query: query.trim(),
    ...rangeKm(f.distance),
    to: whenUntil(f.when, today),
    countries: [...f.countries].sort(),
    terrain: f.terrain,
    verifiedOnly: f.verifiedOnly,
    near,
    radiusKm: near ? f.radius : null,
    sort: near && f.sort === "distance" ? "distance" : "date",
  };
}

// Editions of a search result that answer the filters, soonest first: the dates the row and the
// race page lead with. Past editions only count when the race has no upcoming one.
export function matchingEditions(race: CatalogueRace, f: RaceFilters, todayStr: string): CatalogueEdition[] {
  const until = whenUntil(f.when, new Date(todayStr + "T00:00:00"));
  const hits = (race.editions || []).filter(e => kmInRange(e.distanceKm, f.distance) && (!until || e.date <= until));
  const upcoming = hits.filter(e => e.date >= todayStr).sort((a, b) => a.date.localeCompare(b.date));
  if (upcoming.length) return upcoming;
  return hits.sort((a, b) => b.date.localeCompare(a.date));
}

// Persisted per device (not synced): a filter is a browsing convenience, not account data.
export function readFilters(raw: string | null): RaceFilters {
  try {
    const v = raw ? JSON.parse(raw) as Partial<RaceFilters> : {};
    const d = v.distance;
    const distance = d && Number.isInteger(d.min) && Number.isInteger(d.max) && d.min >= 0 && d.max <= LAST_STOP && d.min <= d.max
      ? { min: d.min, max: d.max } : ANY_DISTANCE;
    return {
      ...DEFAULT_FILTERS,
      distance,
      when: WHEN_MONTHS.includes(v.when as never) ? v.when as number : null,
      countries: Array.isArray(v.countries)
        ? [...new Set(v.countries.filter((c): c is string => typeof c === "string" && /^[A-Z]{2}$/.test(c)))].slice(0, MAX_COUNTRIES)
        : [],
      terrain: v.terrain === "road" || v.terrain === "trail" ? v.terrain : null,
      verifiedOnly: v.verifiedOnly === true,
      radius: RADII.includes(v.radius as never) ? v.radius as number : DEFAULT_FILTERS.radius,
      sort: v.sort === "distance" ? "distance" : "date",
      // Near me needs a fresh fix each visit, so it never restores on.
      near: false,
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}
