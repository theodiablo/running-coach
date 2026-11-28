import { useEffect, useState } from "react";
import { findRaceDuplicates } from "../races";
import type { RaceDuplicate, RaceDuplicateQuery } from "../races";
import { rememberRaces } from "../utils/races";
import { RACE_SEARCH_DEBOUNCE_MS } from "./useRaceSearch";

// The add-race form's live "already listed?" list. A failed lookup lists nothing: the submit-time
// check and the database rule still stand behind it. Stale answers are dropped by key.
export function useRaceDuplicates(query: RaceDuplicateQuery, enabled: boolean): RaceDuplicate[] {
  const key = JSON.stringify(query);
  const [settled, setSettled] = useState<{ key: string; list: RaceDuplicate[] } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const list = await findRaceDuplicates(JSON.parse(key) as RaceDuplicateQuery);
        if (!live) return;
        rememberRaces(list.map(d => d.race));
        setSettled({ key, list });
      } catch (err) {
        console.error("race duplicate lookup failed", err);
        if (live) setSettled({ key, list: [] });
      }
    }, RACE_SEARCH_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [key, enabled]);

  // While a new key is pending, keep showing the last answer so the list doesn't flicker per keystroke.
  return enabled ? settled?.list ?? [] : [];
}
