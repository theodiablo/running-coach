// Badge computation — pure, derived from existing data (runs, plan,
// participations). Simple locked/unlocked. Tone is deliberately gentle &
// inclusive for a fitness app: consistency is *cumulative* (count of active
// weeks), never a fragile "don't break the chain" streak, and WALK runs count
// toward distance/volume/consistency just like runs.
//
// Each badge exposes a `progress` (0..1) and, for locked ones, a short `hint`
// ("8 km to go") so the Dashboard can show a "next badge" teaser. Icons are
// stored as lucide *names* (strings) and mapped in Badge.jsx, keeping this file
// React-free and unit-testable.

import { t } from "../i18n";
import { weekKey } from "./format";
import { isCrossTraining } from "../types";
import type { Participation, Run } from "../types";

export type Badge = {
  id: string;
  label: string;
  Icon: "Footprints" | "Medal" | "Trophy" | "Gauge" | "CalendarCheck" | "CalendarHeart" | "Star" | "Flag" | "MapPin" | "Mountain";
  unlocked: boolean;
  progress: number;
  desc: string;
  hint: string | null;
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

const km1 = (n: number) => (n % 1 === 0 ? n : Math.round(n * 10) / 10);

// A milestone badge: unlocked once `value >= threshold`. Label/desc come from
// the badges.<id> dictionary entries; `unit` (km/wk/m, or null for bare counts)
// shapes the remaining-amount hint. Strings resolve at CALL time, so any caller
// that memoises computeBadges must key on the active language as well as the
// data — otherwise a locale switch leaves stale labels on screen.
function milestone(id: string, Icon: Badge["Icon"], value: number, threshold: number, unit: "km" | "wk" | "m" | null): Badge {
  const unlocked = value >= threshold;
  const remaining = Math.max(0, threshold - value);
  return {
    id, Icon, unlocked,
    label: t(`badges.${id}.label`),
    progress: clamp01(value / threshold),
    desc: t(`badges.${id}.desc`),
    hint: unlocked ? null : unit
      ? t("badges.hint.toGo", { amount: km1(remaining), unit: t(`badges.hint.unit.${unit}`) })
      : t("badges.hint.toGoCount", { count: remaining }),
  };
}

export function computeBadges(runs: Run[] = [], participations: Participation[] = []): Badge[] {
  // Distance badges are about running: "longest run" and the km totals must not
  // count a cross-training session's distance (docs/indoor-sessions.md).
  const runOnly = runs.filter(r => !isCrossTraining(r));
  const maxKm = runOnly.reduce((m, r) => Math.max(m, r.km || 0), 0);
  const totalKm = runOnly.reduce((s, r) => s + (r.km || 0), 0);
  const totalElev = runs.reduce((s, r) => s + (r.elevation || 0), 0);
  const activeWeeks = new Set(runs.filter(r => r.date).map(r => weekKey(r.date))).size;
  const hasGps = runs.some(r => r.source === "gps");
  const wishlisted = participations.length;
  const doneRaces = participations.filter(p => p.status === "done").length;

  return [
    // ── Distance milestones (single longest run; walking counts) ────────────
    milestone("dist-first-5k", "Footprints", maxKm, 5, "km"),
    milestone("dist-first-10k", "Footprints", maxKm, 10, "km"),
    milestone("dist-first-half", "Medal", maxKm, 21, "km"),
    milestone("dist-first-marathon", "Trophy", maxKm, 42, "km"),

    // ── Volume (lifetime distance) ──────────────────────────────────────────
    milestone("vol-100", "Gauge", totalKm, 100, "km"),
    milestone("vol-500", "Gauge", totalKm, 500, "km"),
    milestone("vol-1000", "Gauge", totalKm, 1000, "km"),

    // ── Consistency (cumulative active weeks — forgiving, not a streak) ──────
    milestone("weeks-4", "CalendarCheck", activeWeeks, 4, "wk"),
    milestone("weeks-12", "CalendarCheck", activeWeeks, 12, "wk"),
    milestone("weeks-26", "CalendarHeart", activeWeeks, 26, "wk"),

    // ── Races ───────────────────────────────────────────────────────────────
    milestone("race-wishlist", "Star", wishlisted, 1, null),
    milestone("race-done-1", "Flag", doneRaces, 1, null),
    milestone("race-done-5", "Flag", doneRaces, 5, null),

    // ── Exploration ─────────────────────────────────────────────────────────
    { id: "gps-first", label: t("badges.gps-first.label"), Icon: "MapPin", unlocked: hasGps,
      progress: hasGps ? 1 : 0, desc: t("badges.gps-first.desc"),
      hint: hasGps ? null : t("badges.gps-first.desc") },
    milestone("elev-1000", "Mountain", totalElev, 1000, "m"),
    milestone("elev-5000", "Mountain", totalElev, 5000, "m"),
  ];
}

// The locked badge closest to completion (for the Dashboard teaser). Prefers
// ones with real progress so we don't tease a 0% far-off badge. Returns null
// when everything's unlocked.
export function nextBadge(badges: Badge[] = []) {
  const locked = badges.filter(b => !b.unlocked);
  if (!locked.length) return null;
  return locked.slice().sort((a, b) => b.progress - a.progress)[0];
}

// Ids of every currently-unlocked badge — used to seed `seenBadges` silently on
// first run and to diff for new-unlock toasts thereafter.
export function unlockedIds(badges: Badge[] = []) {
  return badges.filter(b => b.unlocked).map(b => b.id);
}
