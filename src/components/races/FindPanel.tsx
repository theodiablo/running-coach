import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader, Navigation, Search, SlidersHorizontal, X } from "lucide-react";
import { INPUT_CLS, RACE_FILTERS_KEY } from "../../constants";
import { currentLocaleTag } from "../../i18n";
import { useRaceSearch } from "../../hooks/useRaceSearch";
import { useNearMeFilter } from "../../hooks/useNearMeFilter";
import { listRaceCountries } from "../../races";
import { countryName } from "../../utils/country";
import { ymd } from "../../utils/format";
import {
  ANY_DISTANCE, DEFAULT_FILTERS, MAX_COUNTRIES, RADII, WHEN_MONTHS, activeFilterCount, isAnyDistance, kmInRange,
  matchingEditions, nearestStop, rangeLabel, readFilters, searchParams,
} from "../../utils/raceFilters";
import type { RaceFilters } from "../../utils/raceFilters";
import { DistanceRangeSlider } from "./DistanceRangeSlider";
import { RaceRow } from "./RaceRow";
import { AddRaceCard } from "../AddRaceCard";
import type { CatalogueEdition, CatalogueRace, Participation } from "../../types";

type Props = {
  byId: Record<string, Participation>;
  targetEditionId?: string | null;
  myDistanceKm: number;
  onOpen: (race: CatalogueRace, editionId: string | null) => void;
  openRaceForm: () => void;
};

const CHIP = "shrink-0 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold whitespace-nowrap transition-colors ";
const chipCls = (on: boolean) => CHIP + (on
  ? "bg-orange-500/15 border-orange-500/50 text-orange-300"
  : "bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500");
const COUNTRY_PREVIEW = 8;
const LBL = "text-[11px] font-semibold uppercase tracking-widest text-slate-500";

function loadFilters(): RaceFilters {
  try { return readFilters(localStorage.getItem(RACE_FILTERS_KEY)); } catch { return DEFAULT_FILTERS; }
}

// Find a race: server-side search over the shared catalogue, paged with "Load more".
export function FindPanel({ byId, targetEditionId, myDistanceKm, onOpen, openRaceForm }: Props) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  const [filters, setFiltersState] = useState<RaceFilters>(loadFilters);
  const [panel, setPanel] = useState(false);
  const [allCountries, setAllCountries] = useState(false);
  const [countries, setCountries] = useState<{ country: string; races: number }[] | null>(null);
  const near = useNearMeFilter("find_near_me");
  const f: RaceFilters = { ...filters, near: near.nearMe, radius: near.radius };
  const search = useRaceSearch(searchParams(query, f, near.loc));
  const todayStr = ymd(new Date());

  const setFilters = (patch: Partial<RaceFilters>) => {
    const next = { ...filters, ...patch };
    setFiltersState(next);
    try { localStorage.setItem(RACE_FILTERS_KEY, JSON.stringify(next)); } catch { /* per-device convenience only */ }
  };
  const openPanel = () => {
    setPanel(p => !p);
    // An empty answer (a failed load) stays null, so the next open asks again.
    if (countries == null) void listRaceCountries().then(list => setCountries(list.length ? list : null));
  };
  const clearAll = () => {
    setQuery("");
    setAllCountries(false);
    setFilters({ ...DEFAULT_FILTERS, sort: filters.sort });
    if (near.nearMe) void near.toggleNearMe();
  };

  const myStop = myDistanceKm > 0 ? nearestStop(myDistanceKm) : null;
  const myOn = myStop != null && f.distance.min === myStop && f.distance.max === myStop;
  const count = activeFilterCount(f);
  const name = (code: string) => countryName(code, i18n.language) || code;
  const countriesLabel = f.countries.length === 1 ? name(f.countries[0]) : t("races.filters.countriesCount", { count: f.countries.length });
  const toggleCountry = (code: string) => setFilters({
    countries: f.countries.includes(code) ? f.countries.filter(c => c !== code) : [...f.countries, code].slice(-MAX_COUNTRIES),
  });
  // The busiest countries first; a picked one always shows, even past the fold.
  const listed = countries || [];
  const picked = f.countries.filter(c => !listed.some(x => x.country === c)).map(country => ({ country, races: 0 }));
  const shownCountries = [...picked, ...(allCountries ? listed : listed.filter((c, i) => i < COUNTRY_PREVIEW || f.countries.includes(c.country)))];
  const hiddenCountries = allCountries ? 0 : listed.length - shownCountries.length + picked.length;
  const monthFmt = (d: string) => new Date(d + "T12:00:00").toLocaleDateString(currentLocaleTag(), { month: "long", year: "numeric" });

  // Month headers only make sense when the list is in date order.
  const dated = f.sort === "date" || !near.nearMe;
  const rows = search.races.map(race => {
    const editions = matchingEditions(race, f, todayStr);
    const lead = editions[0];
    return { race, editions, group: !dated || !lead ? "" : lead.date < todayStr ? "past" : lead.date.slice(0, 7) };
  });

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"/>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t("races.find.searchPlaceholder")}
          aria-label={t("races.find.searchPlaceholder")} className={INPUT_CLS + " pl-9"}/>
      </div>

      <div className="flex gap-1.5 overflow-x-auto -mx-4 px-4 pb-0.5 [scrollbar-width:none]">
        <button onClick={openPanel} aria-expanded={panel} className={chipCls(panel || count > 0)}>
          <SlidersHorizontal size={13}/>{count ? t("races.filters.buttonCount", { count }) : t("races.filters.button")}
        </button>
        {!isAnyDistance(f.distance) && !myOn && (
          <button onClick={() => setFilters({ distance: ANY_DISTANCE })} className={chipCls(true)}
            aria-label={t("races.filters.remove", { name: rangeLabel(t, f.distance) })}>
            {rangeLabel(t, f.distance)}<X size={12}/>
          </button>
        )}
        {myStop != null && (
          <button onClick={() => setFilters({ distance: myOn ? ANY_DISTANCE : { min: myStop, max: myStop } })}
            aria-pressed={myOn} className={chipCls(myOn)}>
            {t("races.filters.myDistance", { km: myDistanceKm })}
          </button>
        )}
        {f.terrain && (
          <button onClick={() => setFilters({ terrain: null })} className={chipCls(true)}
            aria-label={t("races.filters.remove", { name: t("races.filters." + f.terrain) })}>
            {t("races.filters." + f.terrain)}<X size={12}/>
          </button>
        )}
        {f.when && (
          <button onClick={() => setFilters({ when: null })} className={chipCls(true)}
            aria-label={t("races.filters.remove", { name: t("races.filters.when" + f.when) })}>
            {t("races.filters.when" + f.when)}<X size={12}/>
          </button>
        )}
        {f.countries.length > 0 && (
          <button onClick={() => setFilters({ countries: [] })} className={chipCls(true)}
            aria-label={t("races.filters.remove", { name: countriesLabel })}>
            {countriesLabel}<X size={12}/>
          </button>
        )}
        {f.verifiedOnly && (
          <button onClick={() => setFilters({ verifiedOnly: false })} className={chipCls(true)}
            aria-label={t("races.filters.remove", { name: t("races.filters.verifiedOnly") })}>
            {t("races.filters.verifiedOnly")}<X size={12}/>
          </button>
        )}
        {near.nearMe && (
          <button onClick={() => void near.toggleNearMe()} className={chipCls(true)}
            aria-label={t("races.filters.remove", { name: t("races.find.nearMe") })}>
            <Navigation size={12}/>{t("races.filters.withinKm", { km: near.radius })}<X size={12}/>
          </button>
        )}
      </div>

      {panel && (
        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-4 space-y-4">
          <DistanceRangeSlider value={f.distance} onChange={distance => setFilters({ distance })}/>

          <div>
            <p className={LBL + " mb-1.5"}>{t("races.filters.terrain")}</p>
            <div className="flex bg-slate-900 rounded-xl p-1 gap-1" role="group" aria-label={t("races.filters.terrain")}>
              {([null, "road", "trail"] as const).map(v => (
                <button key={v ?? "all"} aria-pressed={f.terrain === v} onClick={() => setFilters({ terrain: v })}
                  className={"flex-1 py-1.5 rounded-lg text-sm font-semibold transition-colors " + (f.terrain === v ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200")}>
                  {t(v ? "races.filters." + v : "races.filters.allTerrain")}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className={LBL + " mb-1.5"}>{t("races.filters.when")}</p>
            <div className="flex flex-wrap gap-1.5">
              {WHEN_MONTHS.map(m => (
                <button key={m} onClick={() => setFilters({ when: f.when === m ? null : m })} aria-pressed={f.when === m} className={chipCls(f.when === m)}>
                  {t("races.filters.when" + m)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className={LBL + " mb-1.5"}>{t("races.filters.countries")}</p>
            <div className="flex flex-wrap gap-1.5">
              {shownCountries.map(c => {
                const on = f.countries.includes(c.country);
                return (
                  <button key={c.country} onClick={() => toggleCountry(c.country)} aria-pressed={on} className={chipCls(on)}>
                    {name(c.country)}{c.races > 0 && <span className={on ? "text-orange-300/70" : "text-slate-500"}>{c.races}</span>}
                  </button>
                );
              })}
              {countries == null && <Loader size={14} className="animate-spin text-slate-500 self-center"/>}
              {hiddenCountries > 0 && (
                <button onClick={() => setAllCountries(true)} className="text-xs font-semibold text-orange-400 hover:text-orange-300 px-1">
                  {t("races.filters.moreCountries", { count: hiddenCountries })}
                </button>
              )}
            </div>
          </div>

          <div>
            <p className={LBL + " mb-1.5"}>{t("races.find.nearMe")}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <button onClick={() => void near.toggleNearMe()} disabled={near.status === "locating"} aria-pressed={near.nearMe}
                className={chipCls(near.nearMe) + " disabled:opacity-60"}>
                {near.status === "locating" ? <Loader size={12} className="animate-spin"/> : <Navigation size={12}/>}{t("races.find.nearMe")}
              </button>
              {near.nearMe && RADII.map(r => (
                <button key={r} onClick={() => near.setRadius(r)} aria-pressed={near.radius === r} className={chipCls(near.radius === r)}>{r} km</button>
              ))}
            </div>
            {near.status === "denied" && <p className="text-xs text-red-400 mt-1.5">{t("races.find.locationDenied")}</p>}
          </div>

          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              <span className="font-semibold">{t("races.filters.verifiedOnly")}</span>
              <span className="block text-xs text-slate-400">{t("races.filters.verifiedOnlyHint")}</span>
            </span>
            <input type="checkbox" checked={f.verifiedOnly} onChange={e => setFilters({ verifiedOnly: e.target.checked })}
              className="w-5 h-5 accent-orange-500 shrink-0"/>
          </label>
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-slate-400 px-0.5 min-h-5">
        <span aria-live="polite">
          {search.status === "ready" && !!search.total && t(count || query.trim() ? "races.find.matchCount" : "races.find.upcomingCount", { count: search.total })}
        </span>
        <span className="flex items-center gap-3">
          {near.nearMe && (
            <button onClick={() => setFilters({ sort: filters.sort === "distance" ? "date" : "distance" })} className="font-semibold hover:text-slate-200">
              {t(f.sort === "distance" ? "races.filters.sortNearest" : "races.filters.sortSoonest")}
            </button>
          )}
          {(count > 0 || query) && <button onClick={clearAll} className="font-semibold text-orange-400 hover:text-orange-300">{t("races.filters.clearAll")}</button>}
        </span>
      </div>

      {search.status === "loading" && (
        <div className="space-y-2" aria-busy="true" aria-label={t("races.find.searching")}>
          {[0, 1, 2].map(i => <div key={i} className="h-[72px] rounded-2xl bg-slate-800/70 animate-pulse"/>)}
        </div>
      )}
      {search.status === "error" && (
        <div className="bg-slate-800 rounded-2xl p-6 text-center text-sm text-slate-400 space-y-3">
          <p>{t(typeof navigator !== "undefined" && navigator.onLine === false ? "races.find.offline" : "races.find.searchFailed")}</p>
          <button onClick={search.retry} className="bg-slate-700 hover:bg-slate-600 text-slate-100 px-4 py-2 rounded-xl text-sm font-semibold">{t("races.find.retry")}</button>
        </div>
      )}
      {search.status === "ready" && !rows.length && (
        <div className="bg-slate-800 rounded-2xl p-6 text-center text-sm text-slate-400 space-y-3">
          <p>{near.nearMe ? t("races.find.noneInRadius", { radius: near.radius }) : t("races.find.noMatch")}</p>
          {(count > 0 || query) && <button onClick={clearAll} className="text-orange-400 font-semibold">{t("races.filters.clearAll")}</button>}
        </div>
      )}
      {search.status === "ready" && rows.length > 0 && (
        <div className="space-y-2">
          {rows.map(({ race, editions, group }, i) => {
            const lead: CatalogueEdition | undefined = editions[0];
            const header = group && group !== rows[i - 1]?.group
              ? (group === "past" ? t("races.find.pastRaces") : monthFmt(group + "-01")) : null;
            return (
              <div key={race.id}>
                {header && <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-500 mt-3 mb-1.5 px-0.5">{header}</p>}
                <RaceRow race={race} editions={editions} onOpen={() => onOpen(race, lead?.id ?? null)}
                  highlightKm={km => !isAnyDistance(f.distance) && kmInRange(km, f.distance)}
                  onList={(race.editions || []).some(e => byId[e.id])}
                  isTarget={!!targetEditionId && (race.editions || []).some(e => e.id === targetEditionId)}/>
              </div>
            );
          })}
          {search.hasMore && (
            <button onClick={search.loadMore} disabled={search.loadingMore}
              className="w-full mt-1 py-3 rounded-xl border border-dashed border-slate-600 text-sm font-semibold text-slate-300 hover:border-slate-400 disabled:opacity-60 flex items-center justify-center gap-2">
              {search.loadingMore && <Loader size={14} className="animate-spin"/>}
              {search.total != null
                ? t("races.find.loadMoreCount", { count: Math.min(20, search.total - rows.length) })
                : t("races.find.loadMore")}
            </button>
          )}
        </div>
      )}

      <div className="pt-3">
        <AddRaceCard onClick={openRaceForm} subtitle={t("races.find.addSubtitle")}>
          <p className="text-slate-500 text-[11px] px-1">{t("races.find.userSubmittedNote")}</p>
        </AddRaceCard>
      </div>
    </div>
  );
}
