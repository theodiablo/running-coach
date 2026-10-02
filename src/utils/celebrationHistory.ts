import { CELEBRATION_RECENT_KEY } from "../constants";
import { buildCelebration, type Celebration, type CelebrationInput } from "./runCelebration";

const RECENT_MAX = 20;

function readRecent(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(CELEBRATION_RECENT_KEY) || "[]");
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

// buildCelebration with this device's recently-shown lines kept out of the draw.
export function celebrate(input: Omit<CelebrationInput, "recent" | "rand">): Celebration | null {
  const recent = readRecent();
  const c = buildCelebration({ ...input, recent });
  if (!c) return null;
  const shown = [c.headline, ...(c.fact ? [c.fact.key] : [])];
  try {
    localStorage.setItem(CELEBRATION_RECENT_KEY, JSON.stringify([...shown, ...recent.filter(k => !shown.includes(k))].slice(0, RECENT_MAX)));
  } catch { /* storage unavailable: a repeat is the worst case */ }
  return c;
}
