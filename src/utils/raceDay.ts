// Race-day mode: the Home of a runner who onboarded to be followed live, not to
// train (settings.liveFirst). Pure so the card's choices are testable.
import type { Participation, Plan, Run, SettingsState } from "../types";

// `source` on the participation the live onboarding branch creates.
export const RACE_DAY_SOURCE = "raceDay";

// Race-day Home replaces the plan prompts only until a plan exists.
export const inRaceDayMode = (settings: Pick<SettingsState, "liveFirst">, plan: Plan | null) =>
  !!settings.liveFirst && !plan;

// The next wishlisted race on or after today, earliest first.
export function upcomingRace(parts: Participation[] = [], today: string): Participation | null {
  return parts
    .filter(p => p.status === "wishlist" && p.raceDate && p.raceDate >= today)
    .sort((a, b) => String(a.raceDate).localeCompare(String(b.raceDate)))[0] || null;
}

// Whole days from `today` to `date`, both YYYY-MM-DD; never negative.
export function daysUntil(date: string, today: string): number {
  const ms = new Date(date + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime();
  return Math.max(0, Math.round(ms / 86400000));
}

// Any GPS recording counts as the test: the point is that this phone has
// recorded with the screen off before race day.
export const hasTestRun = (runs: Run[]) => runs.some(r => r.source === "gps");

// Race auto-detect candidates for a runner with no plan: with no RACE session to
// stamp an editionId, the wishlist itself is what race day is matched against.
export function wishlistRaceCandidates(parts: Participation[] = []) {
  return parts
    .filter(p => p.status === "wishlist" && p.editionId && p.raceDate && p.distanceKm)
    .map(p => ({ editionId: p.editionId as string, date: p.raceDate as string, distanceKm: Number(p.distanceKm) }));
}
