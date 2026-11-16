import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { peekRaceSearch, raceSearchVersion, searchRaces } from "../races";
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
// no state is set synchronously in the effect; a late response for an older key is dropped. A page
// cached this session renders at once, with no debounce.
export function useRaceSearch(params: RaceSearchParams, enabled = true): RaceSearch {
  const query = JSON.stringify(params);
  const [attempt, setAttempt] = useState(0);
  // A dropped cache (a contribution) is a new key too, so a mounted list asks again.
  const key = query + "#" + attempt + "#" + raceSearchVersion();
  const [settled, setSettled] = useState<Settled | null>(null);
  const [loadingMoreKey, setLoadingMoreKey] = useState<string | null>(null);
  const latest = useRef(key);
  useEffect(() => { latest.current = key; }, [key]);

  useEffect(() => {
    if (!enabled || peekRaceSearch(JSON.parse(query) as RaceSearchParams)) return;
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

  const current = useMemo<Settled | null>(() => {
    if (settled?.key === key) return settled;
    const cached = enabled ? peekRaceSearch(JSON.parse(query) as RaceSearchParams) : null;
    return cached ? { key, ...cached, error: false } : null;
  }, [settled, key, query, enabled]);

  const loadingMore = loadingMoreKey === key;
  const loadMore = useCallback(() => {
    if (!current?.next || loadingMore) return;
    const asked = current.key;
    setLoadingMoreKey(asked);
    searchRaces(JSON.parse(query) as RaceSearchParams, current.next)
      .then(page => {
        rememberRaces(page.races);
        if (latest.current !== asked) return;
        setSettled(s => {
          const base = s && s.key === asked ? s : current;
          return { ...base, races: [...base.races, ...page.races.filter(r => !base.races.some(x => x.id === r.id))], next: page.next };
        });
      })
      .catch(err => console.error("race search page failed", err))
      .finally(() => setLoadingMoreKey(k => k === asked ? null : k));
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
