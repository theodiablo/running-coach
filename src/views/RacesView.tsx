import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Star, Target, X, Check, Plus, Trophy, ChevronRight } from "lucide-react";
import { t as tGlobal } from "../i18n";
import { track } from "../telemetry";
import { fmt, ymd } from "../utils/format";
import { findEdition, editionLabel, isPersonalBest, knownRaces } from "../utils/races";
import { reportRace } from "../races";
import { RaceDateChanges } from "../components/RaceDateChangeCard";
import type { RaceDateChange } from "../utils/races";
import { mainRace } from "../utils/planPhase";
import { planEndYmd } from "../utils/plan";
import { goalKind } from "../utils/recovery";
import { FindPanel } from "../components/races/FindPanel";
import { ResultForm } from "../components/races/RaceForms";
import type { JoinedRace } from "../components/races/RaceForms";
import { RaceSheet } from "../modals/RaceSheet";
import type { CatalogueRace, JoinedEdition, Participation, Plan, RacesState, Run, SettingsState } from "../types";

const SEGMENTS = [["mine", "races.segments.mine"], ["find", "races.segments.find"]];

type Segment = "mine" | "find";
type RacesViewProps = {
  races: RacesState | null;
  dateChanges?: RaceDateChange[];
  applyRaceDateChange?: (c: RaceDateChange) => void;
  keepRaceDate?: (c: RaceDateChange) => void;
  saveRaces: (races: RacesState) => void;
  settings: SettingsState;
  promoteEdition: (joined: JoinedRace | JoinedEdition) => void;
  setRaceInPlan: (editionId: string, inPlan: boolean) => void;
  addRuns: (runs: Run[], opts?: { skipDetect?: boolean }) => void;
  showToast: (msg: string, type?: string) => void;
  openRaceForm: () => void;
  runs?: Run[];
  // The plan's main race is settled through the hub, which ticks its RACE session too.
  plan?: Plan | null;
  settleRace?: (runId: string | null, timeSec: number | null, opts?: { notes?: string; quiet?: boolean }) => boolean;
  previewTargetGoal?: (goalSec: number) => Plan | null;
  updateTargetGoal?: (goalSec: number) => void;
};
type OpenRace = { race: CatalogueRace | JoinedRace; editionId: string | null };

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

export function RacesView({ races, dateChanges, applyRaceDateChange, keepRaceDate, saveRaces, settings, promoteEdition, setRaceInPlan, addRuns, showToast, openRaceForm, runs, plan, settleRace, previewTargetGoal, updateTargetGoal }: RacesViewProps) {
  const { t } = useTranslation();
  const [seg, setSeg] = useState<Segment>("mine");
  const [logFor, setLogFor] = useState<string | null>(null); // editionId being logged
  const [open, setOpen] = useState<OpenRace | null>(null);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayStr = ymd(today);
  const parts = races?.participations || [];
  // Where a plan with no race ends: only a race inside it can be folded in.
  const openEnd = plan && goalKind(plan) !== "race" ? planEndYmd(plan) : null;
  const byId = Object.fromEntries(parts.filter(p => p.editionId).map(p => [p.editionId as string, p]));

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
  const findRace = (raceId: string): CatalogueRace | null => knownRaces().find(r => r.id === raceId) || null;

  const addWishlist = (joined: JoinedRace | JoinedEdition) => {
    upsertPart(joined, { status: "wishlist" });
    showToast(t("races.toast.added"));
  };

  const setTarget = (joined: JoinedRace | JoinedEdition) => { setOpen(null); promoteEdition(joined); };

  // A goal on a race not yet listed lists it: the goal is what says the runner means to race it.
  const setGoal = (joined: JoinedRace, goalSec: number | null) => {
    const listed = parts.some(p => p.editionId === joined.edition.id);
    upsertPart(joined, { goalSec });
    showToast(t(listed ? "races.goal.savedToast" : "races.goal.savedListedToast"));
  };

  const report = (raceSlug: string, reason: string, note: string) => {
    reportRace({ raceSlug, editionId: null, reason, note }).catch(() => {});
    showToast(t("races.toast.reported"));
  };

  const openPart = (p: Participation) => {
    const joined = resolveJoined(p);
    const full = joined.orphan ? null : findRace(String(joined.raceId));
    setOpen({ race: full || joined, editionId: p.editionId || null });
  };

  const saveResult = (joined: JoinedRace | JoinedEdition, timeSec: number, notes: string, alsoLog: boolean) => {
    const ed = joined.edition;
    let runId = null;
    if (alsoLog) {
      runId = "r" + Date.now();
      addRuns([{
        id: runId, date: ed.date, type: "RACE", km: ed.distanceKm, durationSec: timeSec,
        hr: null, hrMax: null, elevation: ed.elevation || undefined, effort: null,
        notes: notes || t("races.result.defaultNote", { label: editionLabel({ name: joined.name }, ed) }),
      }], { skipDetect: true });
    }
    if (settleRace && mainRace(plan, settings)?.editionId === ed.id) {
      // The hub writes the participation and ticks the plan's RACE session together.
      settleRace(runId, timeSec, { notes, quiet: true });
    } else {
      upsertPart(joined, { status: "done", timeSec, notes, source: "manual", runId });
    }
    track("race_completed", { source: "manual" });
    setLogFor(null);
    showToast(t("races.toast.logged"));
  };

  const goalOf = (p: Participation, isTarget: boolean) => isTarget ? Number(settings.goalSec) || 0 : Number(p.goalSec) || 0;

  // ── My Races ──────────────────────────────────────────────────────────────
  const done = parts.filter(p => p.status === "done");
  const wishlist = parts.filter(p => p.status === "wishlist");
  const upcoming = wishlist.filter(p => p.raceDate && p.raceDate >= todayStr).sort((a, b) => String(a.raceDate).localeCompare(String(b.raceDate)));
  const past = wishlist.filter(p => p.raceDate && p.raceDate < todayStr).sort((a, b) => String(b.raceDate).localeCompare(String(a.raceDate)));
  // "Didn't run" answers stay with the past races, still open to a time.
  const skipped = parts.filter(p => p.status === "skipped");
  const pastAll = [...past, ...skipped].sort((a, b) => String(b.raceDate).localeCompare(String(a.raceDate)));

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
          {!!dateChanges?.length && (
            <div className="space-y-3">
              <RaceDateChanges changes={dateChanges} onApply={applyRaceDateChange} onKeep={keepRaceDate}/>
            </div>
          )}
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
                // A race can be folded into the plan when a plan is active (race date set) and it falls before the main race. Keyed off
                // settings.raceDate, not targetEditionId, so a hand-entered main race can still have tune-ups added.
                // A plan with no race date holds a race that falls inside its weeks.
                const inPlannable = settings.raceDate
                  ? !isTarget && String(p.raceDate) < settings.raceDate
                  : !!openEnd && String(p.raceDate) < openEnd;
                return (
                  <div key={p.editionId} className="rounded-2xl p-4 border border-orange-500/30"
                    style={{ background: "linear-gradient(135deg,rgba(249,115,22,.13),rgba(220,38,38,.13))" }}>
                    <button onClick={() => openPart(p)} className="w-full flex justify-between items-start gap-3 text-left">
                      <div className="min-w-0">
                        <p className="font-semibold line-clamp-2 leading-snug">{p.label}<ChevronRight size={15} className="inline text-slate-500 ml-0.5 -mt-0.5"/></p>
                        <p className="text-slate-400 text-sm mt-0.5">{fmt.date(p.raceDate || "") + " · " + p.distanceKm + " km"}
                          {goalOf(p, isTarget) ? " · " + t("races.goal.short", { time: fmt.dur(goalOf(p, isTarget)) }) : ""}</p>
                        {isTarget && <span className="inline-flex items-center gap-1 text-xs text-orange-300 mt-1.5 font-semibold"><Target size={12}/>{t("races.upcoming.trainingTarget")}</span>}
                        {inPlannable && p.inPlan && <span className="inline-flex items-center gap-1 text-xs text-orange-300/80 mt-1.5 font-semibold"><Check size={12}/>{t("races.upcoming.inYourPlan")}</span>}
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-3xl font-black text-orange-400 leading-none">{Math.max(0, days)}</p>
                        <p className="text-slate-400 text-xs mt-0.5">{t("races.upcoming.daysToGo")}</p>
                      </div>
                    </button>
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

          {pastAll.length > 0 && (
            <Section title={t("races.sections.past")}>
              {pastAll.map(p => {
                const joined = resolveJoined(p);
                return (
                  <div key={p.editionId} className="rounded-xl p-4 border border-amber-500/25 bg-amber-500/5">
                    <p className="font-semibold">{p.label}</p>
                    <p className="text-slate-400 text-sm mt-0.5">{fmt.date(p.raceDate || "") + " · " + p.distanceKm + " km"}</p>
                    <p className="text-amber-200/80 text-xs mt-1">{p.status === "skipped" ? t("races.result.skipped") : t("races.past.passed")}</p>
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
        <FindPanel byId={byId} targetEditionId={settings.targetEditionId} myDistanceKm={Number(settings.distanceKm) || 0}
          onOpen={(race, editionId) => setOpen({ race, editionId })} openRaceForm={openRaceForm}/>
      )}

      {open && (
        <RaceSheet race={open.race} editionId={open.editionId} byId={byId} settings={settings} plan={plan} runs={runs || []}
          addWishlist={addWishlist} setGoal={setGoal} removePart={id => removePart(id)} promote={setTarget}
          saveResult={saveResult} report={report} previewTargetGoal={previewTargetGoal} updateTargetGoal={updateTargetGoal}
          onClose={() => setOpen(null)}/>
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

function daysUntil(dateStr: string | undefined, today: Date) {
  if (!dateStr) return 0;
  return Math.ceil((new Date(dateStr + "T00:00:00").getTime() - today.getTime()) / 86400000);
}
