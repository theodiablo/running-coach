import { MAP_KEY } from "../constants";
import { countryCode } from "./country";

// Extract the best-guess { lat, lng } from a MapTiler geocoding response, or
// null. MapTiler (GeoJSON convention) returns center as [lng, lat].
export function parseGeocodeResult(json: unknown) {
  const features = typeof json === "object" && json && "features" in json ? json.features : null;
  const first = Array.isArray(features) ? features[0] : null;
  const center = typeof first === "object" && first && "center" in first ? first.center : null;
  if (!Array.isArray(center) || center.length < 2) return null;
  const [lng, lat] = center;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return { lat, lng };
}

// One-off forward geocode (place name -> coordinates) to centre the race location picker near
// the city the contributor typed. Resolves null (never throws) if unconfigured, offline or no
// match: an optional convenience, never a blocker to setting a location.
export async function geocodePlace(query: string | null | undefined) {
  if (!MAP_KEY || !query?.trim()) return null;
  try {
    const res = await fetch(
      `https://api.maptiler.com/geocoding/${encodeURIComponent(query.trim())}.json?key=${MAP_KEY}&limit=1`,
    );
    if (!res.ok) return null;
    return parseGeocodeResult(await res.json());
  } catch {
    return null;
  }
}

const CITY_TYPES = ["municipality", "locality", "municipal_district", "place"];
type GeoFeature = { id?: unknown; text?: unknown; place_type?: unknown; properties?: unknown; country_code?: unknown };
const asFeature = (v: unknown): GeoFeature | null => (typeof v === "object" && v ? v : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

// The country and city of a MapTiler reverse-geocoding response: read off the feature itself or
// its `context` parents, so a point that lands on a street still yields its town.
export function parseReverseResult(json: unknown): { country: string | null; city: string | null } | null {
  const features = typeof json === "object" && json && "features" in json ? json.features : null;
  const first = asFeature(Array.isArray(features) ? features[0] : null);
  if (!first) return null;
  const context = Array.isArray((first as { context?: unknown }).context) ? (first as { context: unknown[] }).context : [];
  const places = [first, ...context.map(asFeature).filter((c): c is GeoFeature => !!c)];
  let country: string | null = null;
  for (const p of places) {
    const props = asFeature(p.properties);
    country = countryCode(str(props?.country_code) ?? str(p.country_code));
    if (country) break;
  }
  const typesOf = (p: GeoFeature) => (Array.isArray(p.place_type) ? p.place_type : []);
  const idType = (p: GeoFeature) => (str(p.id) ?? "").split(".")[0];
  let city: string | null = null;
  for (const type of CITY_TYPES) {
    const hit = places.find(p => typesOf(p).includes(type) || idType(p) === type);
    city = hit ? str(hit.text) : null;
    if (city) break;
  }
  return country || city ? { country, city: city ? city.slice(0, 80) : null } : null;
}

// One-off reverse geocode of a picked race start, to fill its country and city. Resolves null
// (never throws) if unconfigured, offline or unmatched: the fields stay editable either way.
export const REVERSE_GEOCODE_TIMEOUT_MS = 6000;

export async function reverseGeocode(point: { lat: number; lng: number }) {
  if (!MAP_KEY) return null;
  try {
    const res = await fetch(`https://api.maptiler.com/geocoding/${point.lng},${point.lat}.json?key=${MAP_KEY}`,
      { signal: AbortSignal.timeout(REVERSE_GEOCODE_TIMEOUT_MS) });
    if (!res.ok) return null;
    return parseReverseResult(await res.json());
  } catch {
    return null;
  }
}
