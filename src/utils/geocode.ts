import { MAP_KEY } from "../constants";

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
