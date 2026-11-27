import { countryCode } from "./country";
import { TIMEZONES_BY_COUNTRY } from "./timezoneCountries";

let zoneIndex: Map<string, string> | undefined;

export function countryForTimeZone(timeZone: string | undefined): string | null {
  if (!timeZone) return null;
  if (!zoneIndex) {
    zoneIndex = new Map();
    for (const [cc, zones] of Object.entries(TIMEZONES_BY_COUNTRY)) for (const z of zones.split(" ")) zoneIndex.set(z, cc);
  }
  return countryCode(zoneIndex.get(timeZone));
}

function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function regionOf(tag: string): string | null {
  try {
    return countryCode(new Intl.Locale(tag).region);
  } catch {
    return null;
  }
}

// Where the device is: its time zone, else the region of its language ("fr-BE"). Never
// stored or sent anywhere; it only preselects the add-race form's country.
export function guessCountry(env?: { timeZone?: string; languages?: readonly string[] }): string | null {
  const timeZone = env ? env.timeZone : deviceTimeZone();
  const languages = env ? env.languages ?? [] : typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language];
  const fromZone = countryForTimeZone(timeZone);
  if (fromZone) return fromZone;
  for (const tag of languages) {
    const region = tag ? regionOf(tag) : null;
    if (region) return region;
  }
  return null;
}
