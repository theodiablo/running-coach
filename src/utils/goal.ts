// Goal-time helpers: a pace band, suggested goal and clamping for the plan-setup slider,
// scaled with race distance so only realistic finish times are offered. Anchors are pace
// bounds (s/km) at reference distances covering roughly the fastest/slowest 95% of
// finishers; between anchors linearly interpolated, outside clamped to the nearest.
const ANCHORS = [
  {d: 5,       fast: 180, slow: 480}, // 5K     · 3:00 – 8:00 /km
  {d: 10,      fast: 195, slow: 510}, // 10K    · 3:15 – 8:30 /km
  {d: 21.0975, fast: 210, slow: 540}, // half   · 3:30 – 9:00 /km
  {d: 42.195,  fast: 225, slow: 570}, // full   · 3:45 – 9:30 /km
  {d: 100,     fast: 270, slow: 660}, // ultra  · 4:30 – 11:00 /km
];
type PaceBand = { fast: number; slow: number };

// Returns {fast, slow} pace bounds in sec/km for a distance, or null if the
// distance isn't set yet (so callers can show a "set a distance first" state).
export function paceBand(distanceKm: string | number): PaceBand | null {
  const d = Number(distanceKm);
  if (!d || d <= 0) return null;
  if (d <= ANCHORS[0].d) return {fast: ANCHORS[0].fast, slow: ANCHORS[0].slow};
  for (let i = 0; i < ANCHORS.length - 1; i++) {
    const a = ANCHORS[i], b = ANCHORS[i + 1];
    if (d <= b.d) {
      const t = (d - a.d) / (b.d - a.d);
      return {
        fast: Math.round(a.fast + (b.fast - a.fast) * t),
        slow: Math.round(a.slow + (b.slow - a.slow) * t),
      };
    }
  }
  const last = ANCHORS[ANCHORS.length - 1];
  return {fast: last.fast, slow: last.slow};
}

// Mid-pack-leaning suggested pace (sec/km) — sits a little under the midpoint of
// the band so the default feels achievable rather than slow.
export function suggestedPace(distanceKm: string | number) {
  const b = paceBand(distanceKm);
  return b ? Math.round(b.fast + (b.slow - b.fast) * 0.45) : null;
}

// Suggested goal finish time (seconds) for a freshly entered distance.
export function suggestedGoalSec(distanceKm: string | number) {
  const p = suggestedPace(distanceKm);
  const d = Number(distanceKm);
  return p ? Math.round(p * d) : null;
}

// Keep a goal time inside the distance-appropriate band (in seconds).
export function clampGoalSec(goalSec: number, distanceKm: string | number) {
  const b = paceBand(distanceKm);
  if (!b) return goalSec;
  const d = Number(distanceKm);
  const min = Math.round(b.fast * d);
  const max = Math.round(b.slow * d);
  return Math.min(max, Math.max(min, goalSec));
}
