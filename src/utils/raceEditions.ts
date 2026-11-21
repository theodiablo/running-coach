import type { CatalogueEdition } from "../types";

/**
 * Which editions the race page offers as chips: upcoming ones first (soonest first), past ones only
 * on request, or when there is nothing upcoming, or when the open edition is itself past.
 */
export function editionChoices(editions: CatalogueEdition[], today: string, selectedId: string, showPast: boolean) {
  const upcoming = editions.filter(e => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const past = editions.filter(e => e.date < today).sort((a, b) => b.date.localeCompare(a.date));
  const pastOpen = showPast || !upcoming.length || past.some(e => e.id === selectedId);
  const chips = pastOpen ? [...upcoming, ...past] : upcoming;
  return {
    // One chip is no choice: the section shows nothing but the way to past editions.
    chips: chips.length > 1 ? chips : [],
    pastCount: past.length,
    canTogglePast: upcoming.length > 0 && past.length > 0 && !past.some(e => e.id === selectedId),
  };
}
