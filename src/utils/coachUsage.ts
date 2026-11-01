// Pure helpers for the coach usage ring (CoachChat footer). The budget is enforced server-side
// (coach-agent); this only presents the reported spend. Thresholds are FRACTIONS of the limit,
// not counts, so a per-user override (profiles.coach_daily_limit) escalates sensibly (a limit
// of 20 goes amber at 12).

export type CoachUsage = { used: number; limit: number };

// Tone drives both the ring fill colour and whether a warning label shows.
// normal → ring only (subtle); warn/critical → label + colour; exhausted →
// composer disabled + limit-reached banner.
export type UsageTone = "normal" | "warn" | "critical" | "exhausted";

export const USAGE_COLORS: Record<UsageTone, string> = {
  normal: "#64748b", // slate-500
  warn: "#fbbf24", // amber-400
  critical: "#f87171", // red-400
  exhausted: "#f87171",
};

// Requests remaining today, never negative (the server counter can climb past
// the cap on rejected attempts, but the display clamps).
export function usageLeft(usage: CoachUsage): number {
  return Math.max(0, usage.limit - usage.used);
}

// Fraction of the budget spent, clamped to [0, 1]; guards a zero/absent limit.
export function usageFraction(usage: CoachUsage): number {
  if (!(usage.limit > 0)) return 1;
  return Math.min(1, Math.max(0, usage.used / usage.limit));
}

export function usageTone(usage: CoachUsage): UsageTone {
  const f = usageFraction(usage);
  if (f >= 1) return "exhausted";
  if (f >= 0.8) return "critical";
  if (f >= 0.6) return "warn";
  return "normal";
}
