import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Search, Star, Flag, Target, ExternalLink, X, Check, Plus, Trophy, ChevronRight, Navigation, AlertTriangle, Loader } from "lucide-react";
import { t as tGlobal } from "../i18n";
import { INPUT_CLS, LABEL_CLS } from "../constants";
import { track } from "../telemetry";
import { fmt, ymd } from "../utils/format";
import { hmsToSec } from "../utils/runForm";
import { findEdition, editionLabel, isPersonalBest } from "../utils/races";
import { AddRaceCard } from "../components/AddRaceCard";
import { Chip } from "../components/RaceFilterChips";
import { BANDS, RADII, useNearMeFilter, fmtKm } from "../hooks/useNearMeFilter";
import { haversineM } from "../utils/geo";
import { reportRace } from "../races";
import type { CatalogueEdition, CatalogueRace, JoinedEdition, Participation, RacesState, Run, SettingsState } from "../types";

const SEGMENTS = [["mine", "races.segments.mine"], ["find", "races.segments.find"]];

type Segment = "mine" | "find";
type JoinedRace = Omit<Partial<CatalogueRace>, "editions"> & {
  name: string;
  raceId: string;
  edition: CatalogueEdition;
  orphan?: boolean;
};
type RacesViewProps = {
  races: RacesState | null;
  saveRaces: (races: RacesState) => void;
  settings: SettingsState;
  promoteEdition: (joined: JoinedRace | JoinedEdition) => void;
  setRaceInPlan: (editionId: string, inPlan: boolean) => void;
  addRuns: (runs: Run[], opts?: { skipDetect?: boolean }) => void;
  showToast: (msg: string, type?: string) => void;
  catalogue: CatalogueRace[];
  openRaceForm: () => void;
};

// Resolve a stored participation to its catalogue edition; fall back to the
// snapshot fields if the catalogue no longer lists it (orphan tolerance).
function resolveJoined(part: Participation): JoinedRace | JoinedEdition {
  const found = part.editionId ? findEdition(part.editionId) : null;
  if (found) return found as JoinedEdition;
  return {
    name: part.label || tGlobal("races.fallbackName"), raceId: part.raceId || "", url: null, orphan: true,
    edition: { id: part.editionId || "", date: part.raceDate || "", distanceKm: part.distanceKm || 0 },
  };
}

// Amber "this is user-submitted" tag for any unverified race/edition.
function UnverifiedTag() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-300 bg-amber-500/10 border border-amber-500/25 px-1.5 py-0.5 rounded-md">
      <AlertTriangle size={10}/>{t("races.unverifiedTag")}
    </span>
  );
}

export function RacesView({ races, saveRaces, settings, promoteEdition, setRaceInPlan, addRuns, showToast, catalogue, openRaceForm }: RacesViewProps) {
  const { t } = useTranslation();
  const [seg, setSeg] = useState<Segment>("mine");
  const [logFor, setLogFor] = useState<string | null>(null); // editionId being logged

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayStr = ymd(today);
  const parts = races?.participations || [];
  const byId = Object.fromEntries(parts.filter(p => p.editionId).map(p => [p.editionId as string, p]));
  const cat = catalogue || [];

  // ── persistence ───────────────────────────────────────────────────────────
  const writeParts = (next: Participation[]) => saveRaces({ ...(races || { seenBadges: null }), participations: next });

  const upsertPart = (joined: JoinedRace | JoinedEdition, fields: Partial<Participation>) => {
    const ed = joined.edition;
    const snapshot = {
      editionId: ed.id, raceId: joined.raceId,
      label: editionLabel({ name: joined.name }, ed), raceDate: ed.date, distanceKm: ed.distanceKm,
    };
    const exists = parts.some(p => p.editionId === ed.id);
    const next = exists
      ? parts.map(p => p.editionId === ed.id ? { ...p, ...fields } : p)
      : [...parts, { ...snapshot, status: "wishlist", timeSec: null, runId: null, source: "manual", notes: "", ...fields }];
    writeParts(next);
  };

  const removePart = (editionId?: string | null) => writeParts(parts.filter(p => p.editionId !== editionId));

  const addWishlist = (joined: JoinedRace | JoinedEdition) => {
    upsertPart(joined, { status: "wishlist" });
    showToast(t("races.toast.added"));
  };

  const setTarget = (joined: JoinedRace | JoinedEdition) => { promoteEdition(joined); };

  const saveResult = (joined: JoinedRace | JoinedEdition, timeSec: number, notes: string, alsoLog: boolean) => {
    const ed = joined.edition;
    let runId = null;
    if (alsoLog) {
      runId = "r" + Date.now();
      addRuns([{
        id: runId, date: ed.date, type: "RACE", km: ed.distanceKm, durationSec: timeSec,
        hr: null, hrMax: null, elevation: ed.elevation || undefined, effort: 8,
        notes: notes || t("races.result.defaultNote", { label: editionLabel({ name: joined.name }, ed) }),
      }], { skipDetect: true });
    }
    upsertPart(joined, { status: "done", timeSec, notes, source: "manual", runId });
    track("race_completed", { source: "manual" });
    setLogFor(null);
    showToast(t("races.toast.logged"));
  };

  // ── My Races ──────────────────────────────────────────────────────────────
  const done = parts.filter(p => p.status === "done");
  const wishlist = parts.filter(p => p.status === "wishlist");
  const upcoming = wishlist.filter(p => p.raceDate && p.raceDate >= todayStr).sort((a, b) => String(a.raceDate).localeCompare(String(b.raceDate)));
  const past = wishlist.filter(p => p.raceDate && p.raceDate < todayStr).sort((a, b) => String(b.raceDate).localeCompare(String(a.raceDate)));

  return (
    <div className="max-w-lg mx-auto p-4">
      <h2 className="text-xl font-bold mt-4 mb-4">{t("races.title")}</h2>

      <div className="flex bg-slate-800 rounded-xl p-1 gap-1 mb-5">
        {SEGMENTS.map(([id, label]) => (
          <button key={id} onClick={() => setSeg(id as Segment)}
            className={"flex-1 py-1.5 rounded-lg text-sm font-semibold transition-colors " +
              (seg === id ? "bg-orange-500 text-white" : "text-slate-400 hover:text-slate-200")}>
            {t(label)}
          </button>
        ))}
      </div>

      {seg === "mine" && (
        <div className="space-y-6">
          {!parts.length && (
            <div className="bg-slate-800 rounded-2xl p-6 text-center space-y-3">
              <Trophy size={32} className="mx-auto text-slate-700"/>
              <p className="text-sm text-slate-400">{t("races.empty.none")}</p>
              <button onClick={() => setSeg("find")}
                className="bg-orange-500 hover:bg-orange-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors">
                {t("races.empty.addFirst")}
              </button>
            </div>
          )}

          {upcoming.length > 0 && (
            <Section title={t("races.sections.upcoming")}>
              {upcoming.map(p => {
                const joined = resolveJoined(p);
                const days = daysUntil(p.raceDate, today);
                const isTarget = settings.targetEditionId === p.editionId;
                // A race can be folded into the current plan when there's an active
                // plan (a race date is set) and this race falls before the main race
                // — a checkpoint along the way. We key off settings.raceDate rather
                // than targetEditionId so a hand-entered main race (no catalogue
                // edition) can still have tune-ups added.
                const inPlannable = settings.raceDate && !isTarget && String(p.raceDate) < settings.raceDate;
                return (
                  <div key={p.editionId} className="rounded-2xl p-4 border border-orange-500/30"
                    style={{ background: "linear-gradient(135deg,rgba(249,115,22,.13),rgba(220,38,38,.13))" }}>
                    <div className="flex justify-between items-start gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold line-clamp-2 leading-snug">{p.label}</p>
                        <p className="text-slate-400 text-sm mt-0.5">{fmt.date(p.raceDate || "") + " · " + p.distanceKm + " km"}</p>
                        {isTarget && <span className="inline-flex items-center gap-1 text-xs text-orange-300 mt-1.5 font-semibold"><Target size={12}/>{t("races.upcoming.trainingTarget")}</span>}
                        {inPlannable && p.inPlan && <span className="inline-flex items-center gap-1 text-xs text-orange-300/80 mt-1.5 font-semibold"><Check size={12}/>{t("races.upcoming.inYourPlan")}</span>}
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-3xl font-black text-orange-400 leading-none">{Math.max(0, days)}</p>
                        <p className="text-slate-400 text-xs mt-0.5">{t("races.upcoming.daysToGo")}</p>
                      </div>
                    </div>
                    <div className="flex gap-2 mt-3">
                      {!isTarget && (
                        <button onClick={() => setTarget(joined)}
                          className="flex-1 flex items-center justify-center gap-1.5 bg-orange-500 hover:bg-orange-600 text-white py-2 rounded-xl text-sm font-semibold transition-colors">
                          <Target size={14}/>{t("races.upcoming.setAsTarget")}
                        </button>
                      )}
                      {inPlannable && (
                        <button onClick={() => p.editionId && setRaceInPlan(p.editionId, !p.inPlan)}
                          title={p.inPlan ? t("races.upcoming.removeFromPlan") : t("races.upcoming.addToPlanTitle")}
                          className={"flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold transition-colors " + (p.inPlan ? "bg-orange-500/20 text-orange-300 hover:bg-orange-500/30" : "bg-slate-700 hover:bg-slate-600 text-slate-200")}>
                          {p.inPlan ? <><Check size={14}/>{t("races.upcoming.inPlan")}</> : <><Plus size={14}/>{t("races.upcoming.addToPlan")}</>}
                        </button>
                      )}
                       <button onClick={() => setLogFor(p.editionId || null)}
                        className="flex items-center justify-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 px-3 py-2 rounded-xl text-sm font-semibold transition-colors">
                        <Check size={14}/>{t("common.done")}
                      </button>
                      <button onClick={() => removePart(p.editionId)} aria-label={t("common.remove")}
                        className="flex items-center justify-center text-slate-400 hover:text-red-400 px-2 transition-colors">
                        <X size={16}/>
                      </button>
                    </div>
                    {logFor === p.editionId && <ResultForm joined={joined} onSave={saveResult} onCancel={() => setLogFor(null)}/>}
                  </div>
                );
              })}
            </Section>
          )}

          {past.length > 0 && (
            <Section title={t("races.sections.past")}>
              {past.map(p => {
                const joined = resolveJoined(p);
                return (
                  <div key={p.editionId} className="rounded-xl p-4 border border-amber-500/25 bg-amber-500/5">
                    <p className="font-semibold">{p.label}</p>
                    <p className="text-slate-400 text-sm mt-0.5">{fmt.date(p.raceDate || "") + " · " + p.distanceKm + " km"}</p>
                    <p className="text-amber-200/80 text-xs mt-1">{t("races.past.passed")}</p>
                    <div className="flex gap-2 mt-3">
                       <button onClick={() => setLogFor(p.editionId || null)}
                        className="flex-1 bg-orange-500 hover:bg-orange-600 text-white py-2 rounded-xl text-sm font-semibold transition-colors">
                         {t("races.past.addTime")}
                      </button>
                      <button onClick={() => removePart(p.editionId)} aria-label={t("common.remove")}
                        className="flex items-center justify-center text-slate-400 hover:text-red-400 px-2 transition-colors">
                        <X size={16}/>
                      </button>
                    </div>
                    {logFor === p.editionId && <ResultForm joined={joined} onSave={saveResult} onCancel={() => setLogFor(null)}/>}
                  </div>
                );
              })}
            </Section>
          )}

          {done.length > 0 && (
            <Section title={t("races.sections.completed")}>
              {done.slice().sort((a, b) => String(b.raceDate).localeCompare(String(a.raceDate))).map(p => (
                <div key={p.editionId} className="bg-slate-800 rounded-xl p-4">
                  <div className="flex justify-between items-start gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold line-clamp-2 leading-snug">{p.label}</p>
                       <p className="text-slate-400 text-sm mt-0.5">{fmt.date(p.raceDate || "") + " · " + p.distanceKm + " km"}</p>
                      {p.notes && <p className="text-slate-400 text-xs mt-1 truncate">{p.notes}</p>}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-lg font-bold text-emerald-400 leading-none">{p.timeSec ? fmt.dur(p.timeSec) : "–"}</p>
                       {isPersonalBest(p, parts) && <span className="inline-flex items-center gap-0.5 text-xs text-amber-300 mt-1 font-semibold"><Star size={11}/>{t("races.completed.pb")}</span>}
                    </div>
                  </div>
                  <button onClick={() => removePart(p.editionId)}
                    className="text-xs text-slate-500 hover:text-red-400 mt-2 transition-colors">{t("common.remove")}</button>
                </div>
              ))}
            </Section>
          )}
        </div>
      )}

      {seg === "find" && (
        <FindPanel catalogue={cat} byId={byId} addWishlist={addWishlist}
          logFor={logFor} setLogFor={setLogFor} saveResult={saveResult}
          showToast={showToast} openRaceForm={openRaceForm}/>
      )}
    </div>
  );
}

// ── Find a race (text search + optional "near me" sort) ──────────────────────
// One catalogue list, grouped by race. Text search + event-distance bands
// always apply; the "Near me" toggle layers on a one-off geolocation sort
// (distance shown as "X km away"). Races without coordinates fall into a
// "Location unknown" bucket while Near me is on rather than disappearing.
type FindPanelProps = {
  catalogue: CatalogueRace[];
  byId: Record<string, Participation>;
  addWishlist: (joined: JoinedRace | JoinedEdition) => void;
  logFor: string | null;
  setLogFor: (editionId: string | null) => void;
  saveResult: (joined: JoinedRace | JoinedEdition, timeSec: number, notes: string, alsoLog: boolean) => void;
  showToast: (msg: string, type?: string) => void;
  openRaceForm: () => void;
};

function FindPanel({ catalogue, byId, addWishlist, logFor, setLogFor, saveResult, showToast, openRaceForm }: FindPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null); // raceId expanded
  const [reportFor, setReportFor] = useState<string | null>(null); // raceId being reported
  const [band, setBand] = useState<number | null>(null);          // event distance band (km) or null
  const { nearMe, radius, setRadius, loc, status, toggleNearMe } = useNearMeFilter("find_near_me");

  // Text + band narrow the catalogue; a race passes the band if any of its
  // editions falls in it.
  const matchesBand = (race: CatalogueRace) => band == null || (race.editions || []).some(e => Math.abs(e.distanceKm - band) <= band * 0.12);
  const base = filterRaces(catalogue, query).filter(matchesBand);
  const todayStr = ymd(new Date());

  // With Near me on, split into distance-sorted (within radius) + a
  // location-unknown bucket; races with coordinates beyond the radius drop out.
  // Otherwise sort by soonest upcoming edition (races with only past dates last).
  let located: { race: CatalogueRace; distM: number | null }[];
  const unlocated: CatalogueRace[] = [];
  if (nearMe && loc) {
    const withCoord: { race: CatalogueRace; distM: number }[] = [];
    for (const race of base) {
      if (race.lat == null || race.lng == null) { unlocated.push(race); continue; }
      const distM = haversineM(loc, { lat: race.lat, lng: race.lng });
      if (distM > radius * 1000) continue;
      withCoord.push({ race, distM });
    }
    withCoord.sort((a, b) => a.distM - b.distM);
    located = withCoord;
  } else {
    located = base
      .map(race => ({ race, distM: null }))
      .sort((a, b) => (nextEditionDate(a.race, todayStr) || "9999").localeCompare(nextEditionDate(b.race, todayStr) || "9999"));
  }

  const cardProps = { byId, addWishlist, logFor, setLogFor, saveResult, reportFor, setReportFor, showToast };
  const nothing = located.length === 0 && unlocated.length === 0;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"/>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t("races.find.searchPlaceholder")}
            className={INPUT_CLS + " pl-9"}/>
        </div>
        <div className="flex gap-1.5 flex-wrap items-center">
          <span className="text-[11px] text-slate-500 mr-1">{t("races.find.distance")}</span>
          <Chip active={band == null} onClick={() => setBand(null)}>{t("races.find.all")}</Chip>
          {BANDS.map(b => <Chip key={b} active={band === b} onClick={() => setBand(band === b ? null : b)}>{b} km</Chip>)}
        </div>
        <div className="flex gap-1.5 flex-wrap items-center">
          <button onClick={toggleNearMe} disabled={status === "locating"}
            className={"inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-colors border disabled:opacity-60 " +
              (nearMe ? "bg-orange-500 text-white border-orange-500" : "bg-slate-800 text-slate-300 border-slate-700 hover:border-slate-500")}>
            {status === "locating" ? <Loader size={13} className="animate-spin"/> : <Navigation size={13}/>}
            {t("races.find.nearMe")}
          </button>
          {nearMe && <span className="text-[11px] text-slate-500 mx-1">{t("races.find.within")}</span>}
          {nearMe && RADII.map(r => <Chip key={r} active={radius === r} onClick={() => setRadius(r)}>{r} km</Chip>)}
        </div>
        {status === "denied" && (
          <p className="text-xs text-red-400">{t("races.find.locationDenied")}</p>
        )}
      </div>

      {!catalogue.length ? (
        <div className="bg-slate-800 rounded-2xl p-6 text-center text-sm text-slate-400">
          {t("races.find.catalogueUnavailable")}
        </div>
      ) : nothing ? (
        <div className="bg-slate-800 rounded-2xl p-6 text-center text-sm text-slate-400">
          {nearMe ? t("races.find.noneInRadius", { radius }) : t("races.find.noMatch")}
        </div>
      ) : (
        <>
          {nearMe && located.length === 0 && unlocated.length > 0 && (
            <p className="text-xs text-slate-500">{t("races.find.unlocatedBelow", { radius })}</p>
          )}
          {nearMe && located.length > 0 && (
            <p className="text-[11px] text-slate-500 uppercase tracking-widest">{t("races.find.nearestFirst")}</p>
          )}
          <div className="space-y-2">
            {located.map(({ race, distM }) => (
              <RaceCard key={race.id} race={race} distM={distM}
                open={expanded === race.id} onToggle={() => setExpanded(expanded === race.id ? null : race.id)}
                {...cardProps}/>
            ))}
          </div>
          {unlocated.length > 0 && (
            <div>
              <p className="text-[11px] text-slate-500 uppercase tracking-widest mt-4 mb-2">{t("races.find.locationUnknown")}</p>
              <div className="space-y-2">
                {unlocated.map(race => (
                  <RaceCard key={race.id} race={race} distM={null}
                    open={expanded === race.id} onToggle={() => setExpanded(expanded === race.id ? null : race.id)}
                    {...cardProps}/>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="mt-6">
        <AddRaceCard onClick={openRaceForm} subtitle={t("races.find.addSubtitle")}>
          <p className="text-slate-500 text-[11px] px-1">
            {t("races.find.userSubmittedNote")}
          </p>
        </AddRaceCard>
      </div>
    </div>
  );
}

// A single catalogue race, grouped: collapsed header (name, place, distance
// chips, next upcoming date, unverified flag) expanding to its editions,
// official site link, distance from the user's location (when Near me gave us
// a fix), and a report affordance.
type RaceCardProps = Omit<FindPanelProps, "catalogue" | "openRaceForm"> & {
  race: CatalogueRace;
  distM: number | null;
  open: boolean;
  onToggle: () => void;
  reportFor: string | null;
  setReportFor: (raceId: string | null) => void;
};

function RaceCard({ race, distM, open, onToggle, byId, addWishlist, logFor, setLogFor, saveResult, reportFor, setReportFor, showToast }: RaceCardProps) {
  const { t } = useTranslation();
  const todayStr = ymd(new Date());
  const upcoming = (race.editions || []).filter(e => e.date >= todayStr).sort((a, b) => a.date.localeCompare(b.date));
  const next = upcoming[0];
  const onList = (race.editions || []).some(e => byId[e.id]);
  return (
    <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
      <button onClick={onToggle} className="w-full px-4 py-3 flex items-center gap-2 text-left">
        <div className="flex-1 min-w-0">
          <p className="font-semibold leading-snug line-clamp-2">{race.name}</p>
          <p className="text-slate-400 text-xs mt-0.5">{[race.city, race.country].filter(Boolean).join(", ")}</p>
          <div className="flex gap-1.5 flex-wrap items-center mt-1.5">
            {(race.distances || []).map(d => (
              <span key={d} className="text-[11px] font-semibold text-slate-200 bg-slate-700/70 px-2 py-0.5 rounded-md">{d} km</span>
            ))}
            {onList && (
              <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-emerald-400">
                <Check size={11}/>{t("races.card.onYourList")}
              </span>
            )}
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          {next ? (
            <>
              <p className="text-sm font-bold text-orange-400 leading-none whitespace-nowrap">{fmt.sht(next.date)}</p>
              <p className="text-[10px] text-slate-500 mt-0.5">{next.date.slice(0, 4) + (upcoming.length > 1 ? " · +" + (upcoming.length - 1) : "")}</p>
            </>
          ) : (
            <p className="text-[10px] text-slate-500">{t("races.card.noUpcomingDate")}</p>
          )}
        </div>
        {!race.verified && (
          <span title={t("races.card.unverifiedTitle")} className="flex-shrink-0">
            <AlertTriangle size={13} className="text-amber-400"/>
          </span>
        )}
        <ChevronRight size={16} className={"text-slate-600 transition-transform flex-shrink-0 " + (open ? "rotate-90" : "")}/>
      </button>
      {open && (
        <div className="border-t border-slate-700/50 px-4 py-3 space-y-3">
          {!race.verified && <UnverifiedTag/>}
          {(race.url || distM != null) && <div className="flex items-center gap-4 flex-wrap">
            {race.url && (
              <a href={race.url} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-orange-400 hover:text-orange-300">
                {t("races.card.officialSite")}<ExternalLink size={11}/>
              </a>
            )}
            {distM != null && (
              <span className="inline-flex items-center gap-1 text-xs text-slate-400">
                <Navigation size={11}/>{t("races.card.away", { dist: fmtKm(distM) })}
              </span>
            )}
          </div>}
          <p className="text-[11px] text-slate-500">{t("races.card.datesDisclaimer")}</p>
          {race.editions.map(e => {
            const raceBase = { ...race, editions: undefined };
            const joined: JoinedRace = { ...raceBase, raceId: race.id, edition: e };
            const part = byId[e.id];
            return (
              <div key={e.id} className="flex items-center gap-2 border-t border-slate-700/30 pt-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">{fmt.date(e.date)}</p>
                  <p className="text-xs text-slate-400">{e.distanceKm + " km" + (e.elevation ? " · " + t("races.card.elevation", { elevation: e.elevation }) : "")}</p>
                </div>
                {part ? (
                  <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1 px-2">
                    <Check size={13}/>{part.status === "done" ? t("common.done") : t("races.card.onYourList")}
                  </span>
                ) : (
                  <>
                    <button onClick={() => addWishlist(joined)}
                      className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-orange-500/15 text-orange-300 hover:bg-orange-500/25 transition-colors">
                      <Star size={12}/>{t("races.card.wishlist")}
                    </button>
                    <button onClick={() => setLogFor(e.id)}
                      className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-slate-700 text-slate-200 hover:bg-slate-600 transition-colors">
                      <Flag size={12}/>{t("common.done")}
                    </button>
                  </>
                )}
                {logFor === e.id && <div className="w-full"><ResultForm joined={joined} onSave={saveResult} onCancel={() => setLogFor(null)}/></div>}
              </div>
            );
          })}
          <div className="border-t border-slate-700/30 pt-3">
            {reportFor === race.id ? (
              <ReportForm onSubmit={(reason, note) => {
                reportRace({ raceSlug: race.slug || race.id, editionId: null, reason, note }).catch(() => {});
                setReportFor(null);
                showToast(t("races.toast.reported"));
              }} onCancel={() => setReportFor(null)}/>
            ) : (
              <button onClick={() => setReportFor(race.id)}
                className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-red-400 transition-colors">
                <AlertTriangle size={11}/>{t("races.card.report")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type SectionProps = { title: string; children: ReactNode };

function Section({ title, children }: SectionProps) {
  return (
    <div>
      <p className="text-slate-400 text-xs uppercase tracking-widest mb-2">{title}</p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

// Inline finish-time form for marking a race done. Defaults to also adding a
// RACE run to the log so the result flows into History/Stats/predictions.
type ResultFormProps = {
  joined: JoinedRace | JoinedEdition;
  onSave: (joined: JoinedRace | JoinedEdition, timeSec: number, notes: string, alsoLog: boolean) => void;
  onCancel: () => void;
};

function ResultForm({ joined, onSave, onCancel }: ResultFormProps) {
  const { t } = useTranslation();
  const [h, setH] = useState("");
  const [m, setM] = useState("");
  const [s, setS] = useState("");
  const [notes, setNotes] = useState("");
  const [alsoLog, setAlsoLog] = useState(true);

  const submit = () => {
    const sec = hmsToSec({ dH: h, dM: m, dS: s });
    if (!sec) return;
    onSave(joined, sec, notes, alsoLog);
  };

  return (
    <div className="mt-3 pt-3 border-t border-slate-700/50 space-y-3 w-full">
      <div>
        <label className={LABEL_CLS}>{t("races.result.finishTime")}</label>
        <div className="grid grid-cols-3 gap-2">
          <input type="number" min="0" max="59" placeholder={t("races.result.hoursPlaceholder")} value={h} onChange={e => setH(e.target.value)} className={INPUT_CLS}/>
          <input type="number" min="0" max="59" placeholder={t("races.result.minutesPlaceholder")} value={m} onChange={e => setM(e.target.value)} className={INPUT_CLS}/>
          <input type="number" min="0" max="59" placeholder={t("races.result.secondsPlaceholder")} value={s} onChange={e => setS(e.target.value)} className={INPUT_CLS}/>
        </div>
      </div>
      <input value={notes} onChange={e => setNotes(e.target.value)} placeholder={t("races.result.notesPlaceholder")} className={INPUT_CLS}/>
      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" checked={alsoLog} onChange={e => setAlsoLog(e.target.checked)} className="accent-orange-500"/>
        {t("races.result.alsoLog")}
      </label>
      <div className="flex gap-2">
        <button onClick={submit}
          className="flex-1 flex items-center justify-center gap-1.5 bg-orange-500 hover:bg-orange-600 text-white py-2 rounded-xl text-sm font-semibold transition-colors">
          <Plus size={14}/>{t("races.result.save")}
        </button>
        <button onClick={onCancel} className="px-3 text-sm text-slate-400 hover:text-slate-200">{t("common.cancel")}</button>
      </div>
    </div>
  );
}

// Inline "report this race" form → race_reports + maintainer notification.
const REPORT_REASONS = [
  { value: "Wrong date", key: "wrongDate" },
  { value: "Wrong distance / details", key: "wrongDistance" },
  { value: "Duplicate", key: "duplicate" },
  { value: "Doesn't exist / spam", key: "spam" },
  { value: "Other", key: "other" },
];
type ReportFormProps = { onSubmit: (reason: string, note: string) => void; onCancel: () => void };

function ReportForm({ onSubmit, onCancel }: ReportFormProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState(REPORT_REASONS[0].value);
  const [note, setNote] = useState("");
  return (
    <div className="space-y-2">
      <label className={LABEL_CLS}>{t("races.report.title")}</label>
      <select value={reason} onChange={e => setReason(e.target.value)} className={INPUT_CLS}>
        {REPORT_REASONS.map(r => <option key={r.value} value={r.value}>{t("races.report.reasons." + r.key)}</option>)}
      </select>
      <input value={note} onChange={e => setNote(e.target.value)} placeholder={t("races.report.notePlaceholder")} className={INPUT_CLS}/>
      <div className="flex gap-2">
        <button onClick={() => onSubmit(reason, note)}
          className="flex-1 bg-orange-500 hover:bg-orange-600 text-white py-2 rounded-xl text-sm font-semibold transition-colors">
          {t("races.report.send")}
        </button>
        <button onClick={onCancel} className="px-3 text-sm text-slate-400 hover:text-slate-200">{t("common.cancel")}</button>
      </div>
    </div>
  );
}

// ── small helpers ─────────────────────────────────────────────────────────────
function daysUntil(dateStr: string | undefined, today: Date) {
  if (!dateStr) return 0;
  return Math.ceil((new Date(dateStr + "T00:00:00").getTime() - today.getTime()) / 86400000);
}
function filterRaces(list: CatalogueRace[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(r => (r.name + " " + (r.city || "") + " " + (r.country || "")).toLowerCase().includes(q));
}
// Earliest edition date on/after today, or null if the race only has past dates.
function nextEditionDate(race: CatalogueRace, todayStr: string) {
  const dates = (race.editions || []).map(e => e.date).filter(d => d >= todayStr).sort();
  return dates[0] || null;
}
