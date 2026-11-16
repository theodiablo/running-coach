import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowRight, ChevronLeft, ExternalLink, Flag, Mountain, Navigation, Star, Target, Trash2 } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";
import { INPUT_CLS } from "../constants";
import { fmt, ymd } from "../utils/format";
import { durToSec, secToDur } from "../utils/runForm";
import { goalSuggestions, paceChanges, predictRaceSec, roundGoal } from "../utils/raceGoal";
import { countryName } from "../utils/country";
import { fmtKm } from "../hooks/useNearMeFilter";
import { DurationInput } from "../components/DurationInput";
import { RaceMiniMap } from "../components/races/RaceMiniMap";
import { ReportForm, ResultForm, UnverifiedTag } from "../components/races/RaceForms";
import type { JoinedRace } from "../components/races/RaceForms";
import type { CatalogueEdition, CatalogueRace, Participation, Plan, Run, SettingsState } from "../types";

type Props = {
  // A catalogue race (all its editions), or a lone edition the catalogue no longer lists.
  race: CatalogueRace | JoinedRace;
  editionId: string | null;
  byId: Record<string, Participation>;
  settings: SettingsState;
  plan?: Plan | null;
  runs: Run[];
  addWishlist: (joined: JoinedRace) => void;
  setGoal: (joined: JoinedRace, goalSec: number | null) => void;
  removePart: (editionId: string) => void;
  promote: (joined: JoinedRace) => void;
  saveResult: (joined: JoinedRace, timeSec: number, notes: string, alsoLog: boolean) => void;
  report: (raceSlug: string, reason: string, note: string) => void;
  previewTargetGoal?: (goalSec: number) => Plan | null;
  updateTargetGoal?: (goalSec: number) => void;
  onClose: () => void;
};

const daysTo = (date: string, today: string) =>
  Math.round((new Date(date + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime()) / 86400000);

function editionsOf(race: CatalogueRace | JoinedRace): CatalogueEdition[] {
  const list = "editions" in race && Array.isArray(race.editions) ? race.editions as CatalogueEdition[] : [];
  if (list.length) return list;
  return "edition" in race && race.edition ? [race.edition as CatalogueEdition] : [];
}

// The race page: one edition's details, the runner's goal for it, and what they can do with it.
export function RaceSheet({ race, editionId, byId, settings, plan, runs, addWishlist, setGoal, removePart, promote, saveResult, report, previewTargetGoal, updateTargetGoal, onClose }: Props) {
  const { t, i18n } = useTranslation();
  useDismissable(true, onClose);
  const today = ymd(new Date());
  const editions = editionsOf(race).slice().sort((a, b) => {
    const au = a.date >= today, bu = b.date >= today;
    return au !== bu ? (au ? -1 : 1) : au ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
  });
  const [selId, setSelId] = useState(editionId && editions.some(e => e.id === editionId) ? editionId : editions[0]?.id ?? "");
  const ed = editions.find(e => e.id === selId) || editions[0];
  const raceId = "raceId" in race && race.raceId ? String(race.raceId) : String(race.id || "");
  const base = { ...race, editions: undefined, edition: undefined };
  const joined: JoinedRace | null = ed ? { ...base, name: String(race.name), raceId, edition: ed } as JoinedRace : null;
  const part = ed ? byId[ed.id] : undefined;
  const isTarget = !!ed && settings.targetEditionId === ed.id;
  const upcoming = !!ed && ed.date >= today;
  const done = part?.status === "done";

  const savedGoal = isTarget ? Number(settings.goalSec) || 0 : Number(part?.goalSec) || 0;
  const [goalDraft, setGoalDraft] = useState(() => secToDur(savedGoal));
  const [prevSaved, setPrevSaved] = useState(savedGoal);
  const [prevEd, setPrevEd] = useState(ed?.id);
  if (savedGoal !== prevSaved || ed?.id !== prevEd) {
    setPrevSaved(savedGoal);
    setPrevEd(ed?.id);
    setGoalDraft(secToDur(savedGoal));
  }
  const [logging, setLogging] = useState(false);
  const [reporting, setReporting] = useState(false);

  if (!ed || !joined) return null;
  const goalSec = durToSec(goalDraft);
  const predicted = predictRaceSec(runs, ed.distanceKm, ed.elevation || 0, today);
  const suggestions = goalSuggestions(predicted);
  const goalChanged = goalSec > 0 && goalSec !== savedGoal;
  const preview = isTarget && goalChanged && previewTargetGoal ? previewTargetGoal(goalSec) : null;
  const changes = preview ? paceChanges(plan, preview, today) : [];
  const days = daysTo(ed.date, today);
  const lat = typeof race.lat === "number" ? race.lat : null;
  const lng = typeof race.lng === "number" ? race.lng : null;
  const place = [race.city, race.country ? countryName(String(race.country), i18n.language) || race.country : null].filter(Boolean).join(", ");
  const url = typeof race.url === "string" ? race.url : null;
  const distKm = typeof race.distKm === "number" ? race.distKm : null;

  // A non-target goal saves as soon as it settles; on a race not yet listed it lists it too.
  const commitGoal = (digits: string) => {
    if (isTarget) return;
    const sec = durToSec(digits);
    if (sec === (Number(part?.goalSec) || 0)) return;
    setGoal(joined, sec || null);
  };
  const pickSuggestion = (sec: number) => {
    setGoalDraft(secToDur(sec));
    if (!isTarget) setGoal(joined, sec);
  };

  return (
    <div className="fixed inset-0 z-40 bg-slate-900 overflow-y-auto animate-slide-up" role="dialog" aria-modal="true" aria-label={String(race.name)}>
      <div className="max-w-lg mx-auto pb-12" style={{ paddingBottom: "calc(3rem + var(--safe-bottom))" }}>
        <div className="px-4 pb-5 border-b border-slate-800"
          style={{ paddingTop: "calc(0.75rem + var(--safe-top))", background: "linear-gradient(160deg,rgba(249,115,22,.2),rgba(220,38,38,.08) 55%,transparent)" }}>
          <button onClick={onClose} aria-label={t("common.back")}
            className="w-9 h-9 rounded-full bg-slate-800/80 hover:bg-slate-700 grid place-items-center text-slate-200">
            <ChevronLeft size={20}/>
          </button>
          <h2 className="text-2xl font-extrabold leading-tight mt-3">{race.name}</h2>
          <p className="text-sm text-slate-300 mt-1">{[place, fmt.date(ed.date)].filter(Boolean).join(" · ")}</p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {isTarget && <span className="inline-flex items-center gap-1 text-xs font-semibold text-orange-300 bg-orange-500/15 px-2 py-0.5 rounded-md"><Target size={12}/>{t("races.upcoming.trainingTarget")}</span>}
            {!isTarget && part && !done && <span className="text-xs font-semibold text-emerald-300 bg-emerald-500/10 px-2 py-0.5 rounded-md">{t("races.card.onYourList")}</span>}
            {race.terrain === "trail" && <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-300 bg-emerald-500/10 px-2 py-0.5 rounded-md"><Mountain size={12}/>{t("races.filters.trail")}</span>}
            {race.verified === false && <UnverifiedTag/>}
          </div>
          <div className="grid grid-cols-3 gap-2 mt-4">
            <Stat value={ed.distanceKm + " km"} label={t("races.sheet.distance")}/>
            <Stat value={ed.elevation ? "+" + ed.elevation + " m" : "–"} label={t("races.sheet.elevation")}/>
            {done
              ? <Stat value={part?.timeSec ? fmt.dur(part.timeSec) : "–"} label={t("races.sheet.yourTime")}/>
              : <Stat value={upcoming ? String(days) : "–"} label={upcoming ? t("races.upcoming.daysToGo") : t("races.sheet.passed")}/>}
          </div>
        </div>

        {editions.length > 1 && (
          <Section label={t("races.sheet.editions")}>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("races.sheet.editions")}>
              {editions.map(e => (
                <button key={e.id} role="radio" aria-checked={e.id === ed.id} onClick={() => { setSelId(e.id); setLogging(false); }}
                  className={"text-left rounded-xl border px-3 py-1.5 text-xs transition-colors " + (e.id === ed.id
                    ? "border-orange-500 bg-orange-500/10 text-orange-200" : "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500")
                    + (e.date < today ? " opacity-70" : "")}>
                  <span className="block text-sm font-bold">{e.distanceKm} km</span>{fmt.sht(e.date) + " " + e.date.slice(0, 4)}
                </button>
              ))}
            </div>
          </Section>
        )}

        {!done && (upcoming || savedGoal > 0) && (
          <Section label={t(isTarget ? "races.goal.targetLabel" : "races.goal.label")}>
            <div className="bg-slate-800 border border-slate-700 rounded-2xl p-3 space-y-3">
              <div className="flex items-center gap-3">
                <DurationInput id="race-goal" value={goalDraft} onChange={setGoalDraft} onCommit={commitGoal}
                  placeholder={t("races.goal.placeholder")} aria-label={t("races.goal.label")}
                  className={INPUT_CLS + " flex-1 text-xl font-extrabold tabular-nums"}/>
                <div className="text-right shrink-0">
                  <p className="text-base font-bold tabular-nums">{goalSec ? fmt.pace(goalSec / ed.distanceKm) : "--:--"}</p>
                  <p className="text-[11px] text-slate-400">{t("races.goal.perKm")}</p>
                </div>
              </div>
              {suggestions.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {suggestions.map(s => (
                    <button key={s.key} onClick={() => pickSuggestion(s.sec)} aria-pressed={goalSec === s.sec}
                      className={"rounded-full border px-3 py-1 text-xs font-semibold transition-colors " + (goalSec === s.sec
                        ? "bg-orange-500/15 border-orange-500/50 text-orange-300" : "bg-slate-900 border-slate-700 text-slate-300 hover:border-slate-500")}>
                      {t("races.goal." + s.key, { time: fmt.dur(s.sec) })}
                    </button>
                  ))}
                </div>
              )}
              <p className="text-xs text-slate-500">
                {predicted
                  ? t(ed.elevation ? "races.goal.predictedHillHint" : "races.goal.predictedHint", { time: fmt.dur(roundGoal(predicted)), elevation: ed.elevation })
                  : t("races.goal.noPrediction")}
              </p>
              {isTarget && changes.length > 0 && (
                <div className="rounded-xl border border-orange-500/30 bg-orange-500/5 p-3 text-sm">
                  <p className="font-semibold mb-1.5">{t("races.goal.paceChangeTitle")}</p>
                  <table className="w-full tabular-nums text-xs">
                    <tbody>
                      {changes.map(c => (
                        <tr key={c.type}>
                          <td className="py-0.5 text-slate-300">{t("races.goal.paceRow." + c.type)}</td>
                          <td className="py-0.5 text-right text-slate-500">{fmt.pace(c.before)}</td>
                          <td className="py-0.5 w-5 text-center text-slate-600"><ArrowRight size={11} className="inline"/></td>
                          <td className="py-0.5 text-right font-bold text-orange-300">{fmt.pace(c.after)} {t("races.goal.perKm")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-[11px] text-slate-400 mt-1.5">{t("races.goal.progressKept")}</p>
                </div>
              )}
              {isTarget && updateTargetGoal && (
                <button onClick={() => updateTargetGoal(goalSec)} disabled={!goalChanged}
                  className="w-full flex items-center justify-center gap-1.5 bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white py-2.5 rounded-xl text-sm font-bold transition-colors">
                  <Target size={15}/>{preview ? t("races.goal.updatePlan", { time: fmt.dur(goalSec) }) : t("races.goal.saveGoal")}
                </button>
              )}
            </div>
          </Section>
        )}

        <Section>
          <div className="space-y-2">
            {!part && (
              <button onClick={() => addWishlist(joined)}
                className="w-full flex items-center justify-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-slate-100 py-2.5 rounded-xl text-sm font-bold transition-colors">
                <Star size={15}/>{t("races.sheet.addToList")}
              </button>
            )}
            {upcoming && !isTarget && !done && (
              <button onClick={() => promote(joined)}
                className="w-full flex items-center justify-center gap-1.5 bg-orange-500 hover:bg-orange-600 text-white py-2.5 rounded-xl text-sm font-bold transition-colors">
                <Target size={15}/>{t("races.sheet.setTarget")}
              </button>
            )}
            {!done && (
              logging
                ? <ResultForm joined={joined} onSave={(...a) => { saveResult(...a); setLogging(false); }} onCancel={() => setLogging(false)}/>
                : (
                  <button onClick={() => setLogging(true)}
                    className="w-full flex items-center justify-center gap-1.5 bg-slate-800 border border-slate-700 hover:border-slate-500 text-slate-200 py-2.5 rounded-xl text-sm font-semibold transition-colors">
                    <Flag size={15}/>{t("races.sheet.logResult")}
                  </button>
                )
            )}
            {part && (
              <button onClick={() => removePart(ed.id)}
                className="w-full flex items-center justify-center gap-1.5 text-slate-400 hover:text-red-400 py-2 text-xs font-semibold transition-colors">
                <Trash2 size={13}/>{t("races.sheet.removeFromList")}
              </button>
            )}
          </div>
        </Section>

        {(lat != null && lng != null) || url || distKm != null ? (
          <Section label={t("races.sheet.where")}>
            <div className="space-y-2">
              {lat != null && lng != null && <RaceMiniMap lat={lat} lng={lng} label={t("races.sheet.mapLabel", { name: race.name })}/>}
              <div className="flex items-center justify-between gap-3 text-sm">
                {url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-orange-400 hover:text-orange-300">
                    {t("races.card.officialSite")}<ExternalLink size={12}/>
                  </a>
                ) : <span/>}
                {distKm != null && <span className="inline-flex items-center gap-1 text-xs text-slate-400"><Navigation size={11}/>{t("races.card.away", { dist: fmtKm(distKm * 1000) })}</span>}
              </div>
            </div>
          </Section>
        ) : null}

        <div className="px-4 pt-4 space-y-3">
          <p className="text-[11px] text-slate-500">{t("races.card.datesDisclaimer")}</p>
          {!("orphan" in race && race.orphan) && (reporting ? (
            <ReportForm onSubmit={(reason, note) => { report(String(race.slug || raceId), reason, note); setReporting(false); }} onCancel={() => setReporting(false)}/>
          ) : (
            <button onClick={() => setReporting(true)} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-red-400 transition-colors">
              <AlertTriangle size={12}/>{t("races.card.report")}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl bg-slate-900/60 px-2.5 py-2">
      <p className="text-base font-bold tabular-nums leading-tight">{value}</p>
      <p className="text-[11px] text-slate-400">{label}</p>
    </div>
  );
}

function Section({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="px-4 py-4 border-b border-slate-800">
      {label && <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-500 mb-2">{label}</p>}
      {children}
    </div>
  );
}
