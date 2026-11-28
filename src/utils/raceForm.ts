import { addDays } from "./format";
import type { RaceTerrain } from "../races";

// Mirrors the race_editions insert policy: a race date from a year back to two years ahead.
export function raceDateBounds(today: string): { min: string; max: string } {
  return { min: addDays(today, -365), max: addDays(today, 731) };
}

export const raceDateInBounds = (date: string, today: string) => {
  const { min, max } = raceDateBounds(today);
  return date >= min && date <= max;
};

// Climb per km above what the terrain usually sees: most often an altitude typed as the gain.
const CLIMB_M_PER_KM: Record<RaceTerrain, number> = { road: 25, trail: 150 };
export function climbLooksHigh(distanceKm: number, elevation: number, terrain: RaceTerrain): boolean {
  return distanceKm > 0 && elevation > 0 && elevation / distanceKm > CLIMB_M_PER_KM[terrain];
}

// Race URLs are contributed by other users and rendered as links: web links only, never a custom
// scheme that would reach the app's own deep-link handler, and a real host (races_url_host).
// Repeated or broken scheme prefixes are repaired: "https://https//:x.com" is x.com.
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;
const WEB_HOST = /^([a-z0-9-]+\.)+([a-z]{2,}|xn--[a-z0-9-]+)$/i;
export function raceUrl(value: string | null | undefined): string | null {
  const s = (value || "").trim();
  if (!s || /\s/.test(s)) return null;
  const rest = s.replace(/^(?:https?[:/]+)+/i, "");
  if (rest === s && OTHER_SCHEME.test(s)) return null;
  try {
    const u = new URL(`${/^http:\/\//i.test(s) ? "http" : "https"}://${rest}`);
    return WEB_HOST.test(u.hostname) && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

export const tidyName = (s: string) => s.trim().replace(/\s+/g, " ");
