import { useCallback, useEffect, useState } from "react";
import { searchRaces } from "../races";
import type { RaceCursor, RaceSearchParams } from "../races";
import { rememberRaces } from "../utils/races";
import type { CatalogueRace } from "../types";

export const RACE_SEARCH_DEBOUNCE_MS = 300;

type Settled = { key: string; races: CatalogueRace[]; next: RaceCursor | null; total: number | null; error: boolean };

export type RaceSearch = {
  races: CatalogueRace[];
  total: number | null;
  status: "loading" | "ready" | "error";
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
};

// Paged server-side catalogue search. Loading is derived (the settled key lags the asked one), so
// no state is set synchronously in the effect; a late response for an older key is dropped.
export function useRaceSearch(params: RaceSearchParams, enabled = true): RaceSearch {
  const query = JSON.stringify(params);
  const [attempt, setAttempt] = useState(0);
  const key = query + "#" + attempt;
  const [settled, setSettled] = useState<Settled | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const page = await searchRaces(JSON.parse(query) as RaceSearchParams);
        if (!live) return;
        rememberRaces(page.races);
        setSettled({ key, races: page.races, next: page.next, total: page.total, error: false });
      } catch (err) {
        console.error("race search failed", err);
        if (live) setSettled({ key, races: [], next: null, total: null, error: true });
      }
    }, RACE_SEARCH_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [key, query, enabled]);

  const current = settled?.key === key ? settled : null;

  const loadMore = useCallback(() => {
    if (!current?.next || loadingMore) return;
    const asked = current.key;
    setLoadingMore(true);
    searchRaces(JSON.parse(query) as RaceSearchParams, current.next)
      .then(page => {
        rememberRaces(page.races);
        setSettled(s => s && s.key === asked
          ? { ...s, races: [...s.races, ...page.races.filter(r => !s.races.some(x => x.id === r.id))], next: page.next }
          : s);
      })
      .catch(err => console.error("race search page failed", err))
      .finally(() => setLoadingMore(false));
  }, [current, loadingMore, query]);

  const retry = useCallback(() => setAttempt(a => a + 1), []);

  return {
    races: current?.races || [],
    total: current?.total ?? null,
    status: !current ? "loading" : current.error ? "error" : "ready",
    hasMore: !!current?.next,
    loadingMore,
    loadMore,
    retry,
  };
}
