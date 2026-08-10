import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Award, Check, ChevronRight, Play, Plus, Radio, Route, X, Zap } from "lucide-react";
import { TBG, TCLR } from "../constants";
import type { LiveRunRow } from "../live/publisher";
import { fmt, ymd, estMin } from "../utils/format";
import { describeSession } from "../utils/sessionDesc";
import { computeBadges, nextBadge } from "../utils/badges";
import { sessionSteps } from "../utils/sessionSteps";
import { CoachAvatar } from "../components/CoachAvatar";
import { HRTarget } from "../components/HRTarget";
import { RunRow } from "../components/RunRow";
import type { CoachSource, Plan, PlanSession, RacesState, Run, RunType, SettingsState } from "../types";

type DashboardSession = PlanSession & { wNum: number };
type DashboardProps = {
  runs: Run[];
  plan: Plan | null;
  settings: SettingsState;
  races: RacesState | null;
  goTab: (tab: string) => void;
  goProgress: (sub: string) => void;
  goLog: (prefill: Partial<Run>) => void;
  toggleSess: (weekNumber: number, sessionId: string) => void;
  skipSess: (weekNumber: number, sessionId: string) => void;
  openSettings: () => void;
  openCoach: (session?: null, source?: CoachSource) => void;
  openRunDetail?: (run: Run) => void;
  // A run this account is recording on another device right now (premium live
  // sharing). Null whenever there is nothing to follow.
  liveRun?: LiveRunRow | null;
  openLiveWatch?: () => void;
  // An interrupted recording waiting to be resumed/saved (the app was killed
  // mid-run). Opening the tracker surfaces its resume/discard card.
  recovery?: { km: number; startedAt: number | null } | null;
  openTracker?: () => void;
};

const sessionTypeClass = (type: PlanSession["type"], classes: Record<string, string>) => classes[(type as RunType) || "OTHER"] || classes.OTHER;

export function Dashboard({runs, plan, settings, races, goTab, goProgress, goLog, toggleSess, skipSess, openSettings, openCoach, openRunDetail, liveRun, openLiveWatch, recovery, openTracker}: DashboardProps) {
  const { t } = useTranslation();
  // "How it unfolds" breakdown on the next-session card (collapsed by default).
  const [showSteps, setShowSteps] = useState(false);
  const nb = nextBadge(computeBadges(runs, races?.participations || []));
  const today    = new Date(); today.setHours(0,0,0,0);
  const raceD    = new Date(settings.raceDate + "T00:00:00");
  const daysLeft = Math.max(0, Math.ceil((raceD.getTime() - today.getTime()) / 86400000));
  // The soonest secondary race folded into the plan before the main race — a
  // checkpoint to flag under the main-race countdown.
  const todayStr = ymd(today);
  const nextRace = (races?.participations || [])
    .filter(p => p.status === "wishlist" && p.inPlan && p.raceDate && p.raceDate >= todayStr && p.raceDate < settings.raceDate)
      .sort((a, b) => String(a.raceDate).localeCompare(String(b.raceDate)))[0];
  // Carry the week number alongside each session so the card's Record / Mark
  // done actions can target the right session via goLog / toggleSess.
  const nextSess = plan
    ? plan.weeks.flatMap(w => w.sessions.map(s => ({...s, wNum: w.weekNumber} as DashboardSession)))
        .filter(s => !s.done && !s.skipped && new Date(s.date + "T00:00:00") >= today)
        .sort((a, b) => a.date.localeCompare(b.date))[0]
    : null;
  const nextIsToday = nextSess && nextSess.date === ymd(today);
  const wkMon = new Date(today); wkMon.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const wkKm  = runs.filter(r => new Date(r.date + "T00:00:00") >= wkMon).reduce((s, r) => s + (r.km||0), 0);
  const totKm = runs.reduce((s, r) => s + (r.km||0), 0);

  const statCards = [
    {l:t("dashboard.stats.thisWeek"),  v:wkKm.toFixed(1)+" km",  c:"text-orange-400",  I:Zap},
    {l:t("dashboard.stats.runsRecorded"), v:String(runs.length),    c:"text-sky-400",     I:Activity},
    {l:t("dashboard.stats.total"),       v:totKm.toFixed(0)+" km", c:"text-emerald-400", I:Route},
  ];

  return (
    <div className="p-4 space-y-5 max-w-lg mx-auto">
      <div className="pt-4">
        {settings.name ? (
          <>
            <p className="text-slate-400 text-sm">{t("dashboard.greeting")}</p>
            <h1 className="text-2xl font-bold">{t("dashboard.greetingName", {name: settings.name})}</h1>
          </>
        ) : (
          <h1 className="text-2xl font-bold">{t("dashboard.greetingAnon")}</h1>
        )}
      </div>

      {recovery && openTracker && (
        <button onClick={() => openTracker()}
          className="w-full rounded-xl p-3.5 flex items-center gap-3 text-left border border-orange-500/40 bg-orange-500/10 hover:bg-orange-500/15 transition-colors">
          <Play size={18} className="text-orange-400 flex-shrink-0"/>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-orange-100">{t("dashboard.recovery.title")}</p>
            <p className="text-xs text-orange-300/80">
              {t("dashboard.recovery.subtitle", {
                km: recovery.km.toFixed(1),
                date: recovery.startedAt ? fmt.sht(ymd(new Date(recovery.startedAt))) : "",
              })}
            </p>
          </div>
          <span className="text-xs font-semibold text-orange-200 flex-shrink-0">{t("dashboard.recovery.action")}</span>
        </button>
      )}

      {liveRun && openLiveWatch && (
        <button onClick={openLiveWatch}
          className="w-full rounded-xl p-3.5 flex items-center gap-3 text-left border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/15 transition-colors">
          <span className="relative flex h-2.5 w-2.5 flex-shrink-0" aria-hidden>
            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping"/>
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400"/>
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-emerald-100">{t("liveShare.banner.title")}</p>
            <p className="text-xs text-emerald-300/80">{t("liveShare.banner.subtitle", {km: (liveRun.stats?.km ?? 0).toFixed(1)})}</p>
          </div>
          <span className="flex items-center gap-1 text-xs font-semibold text-emerald-200 flex-shrink-0">
            <Radio size={14}/>{t("liveShare.banner.action")}
          </span>
        </button>
      )}

      <div className="rounded-2xl p-5 border border-orange-500/30"
        style={{background:"linear-gradient(135deg,rgba(249,115,22,.13),rgba(220,38,38,.13))"}}>
        {settings.raceDate && settings.distanceKm ? (
        <>
        <div className="flex justify-between items-center">
          <div>
            <p className="text-orange-300 text-xs font-semibold uppercase tracking-widest mb-1">{t("dashboard.race.title")}</p>
            <p className="font-semibold">{fmt.date(settings.raceDate)}</p>
            <p className="text-slate-400 text-sm mt-1">
              {t("dashboard.race.summary", {distance: settings.distanceKm, goal: fmt.dur(Number(settings.goalSec) || 0), pace: fmt.pace(Math.round(Number(settings.goalSec)/Number(settings.distanceKm)))})}
            </p>
          </div>
          <div className="text-right">
            <p className="text-5xl font-black text-orange-400 leading-none">{daysLeft}</p>
            <p className="text-slate-400 text-xs mt-1">{t("dashboard.race.daysToGo")}</p>
          </div>
        </div>
        {nextRace && (
          <button onClick={() => goTab("races")}
            className="w-full text-left mt-3 pt-3 border-t border-orange-500/20 flex justify-between items-center gap-2">
            <span className="text-xs text-slate-300 truncate">
              <span className="text-orange-300/80 font-semibold">{t("dashboard.race.nextUp")}</span>
              {nextRace.label + " · " + nextRace.distanceKm + "km"}
            </span>
            <span className="text-xs text-slate-400 flex-shrink-0">{t("dashboard.race.daysShort", {days: Math.max(0, Math.ceil((new Date(nextRace.raceDate + "T00:00:00").getTime() - today.getTime()) / 86400000))})}</span>
          </button>
        )}
        </>
        ) : (
          <button onClick={() => goTab("plan")} className="w-full text-left">
            <p className="text-orange-300 text-xs font-semibold uppercase tracking-widest mb-1">{t("dashboard.race.title")}</p>
            <p className="font-semibold">{t("dashboard.race.setupTitle")}</p>
            <p className="text-slate-400 text-sm mt-1">{t("dashboard.race.setupHint")}</p>
          </button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {statCards.map(card => (
          <div key={card.l} className="bg-slate-800 rounded-xl p-3">
            <card.I size={15} className={card.c}/>
            <p className={"text-xl font-bold mt-1 leading-tight " + card.c}>{card.v}</p>
            <p className="text-slate-400 text-xs">{card.l}</p>
          </div>
        ))}
      </div>

      {nb && (
        <button onClick={() => goProgress("badges")}
          className="w-full bg-slate-800 rounded-xl p-3 flex items-center gap-3 text-left hover:bg-slate-700/70 transition-colors">
          <Award size={20} className="text-orange-400 flex-shrink-0"/>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-slate-400">{t("dashboard.nextBadge")}</p>
            <p className="text-sm font-semibold truncate">{nb.label + (nb.hint ? " · " + nb.hint : "")}</p>
            <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden mt-1.5">
              <div className="h-full bg-gradient-to-r from-orange-500 to-amber-400 rounded-full" style={{width: Math.round(nb.progress * 100) + "%"}}/>
            </div>
          </div>
          <ChevronRight size={16} className="text-slate-600 flex-shrink-0"/>
        </button>
      )}

      {nextSess ? (
        <div>
          <p className="text-orange-300 text-xs font-bold uppercase tracking-widest mb-2">
            {nextIsToday ? t("dashboard.session.today") : t("dashboard.session.upNext")}
          </p>
          <div className={"border-2 rounded-2xl p-4 " + sessionTypeClass(nextSess.type, TBG)}>
            <button onClick={() => goTab("plan")} className="w-full text-left group" title={t("dashboard.session.viewInPlan")}>
              <div className="flex items-start justify-between gap-2">
                <span className={"text-xs font-bold uppercase tracking-wide " + sessionTypeClass(nextSess.type, TCLR)}>
                  {t("common.types." + nextSess.type, {defaultValue: nextSess.type})}
                </span>
                <ChevronRight size={16} className="text-slate-500 group-hover:text-slate-300 transition-colors flex-shrink-0 mt-0.5"/>
              </div>
              <p className="text-white text-base font-medium mt-1 leading-snug">{describeSession(nextSess)}</p>
              <p className="text-slate-400 text-xs mt-2">
                {fmt.sht(nextSess.date) + " · " + nextSess.km + " km · ~" + estMin(Number(nextSess.km), nextSess.pace) + " · " + fmt.pace(nextSess.pace) + "/km"}
              </p>
            </button>
            <HRTarget type={nextSess.type} settings={settings} openSettings={openSettings}/>
            <button onClick={() => setShowSteps(v => !v)}
              className="mt-2 flex items-center gap-1 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors">
              <ChevronRight size={12} className={"transition-transform " + (showSteps ? "rotate-90" : "")}/>
              {t("dashboard.session.howItUnfolds")}
            </button>
            {showSteps && (
              <div className="mt-2 space-y-1.5 border-l-2 border-slate-700 pl-3">
                {sessionSteps(nextSess).map(st => (
                  <p key={st.label} className="text-xs text-slate-400 leading-snug">
                    <span className="text-slate-300 font-semibold">{st.label}: </span>{st.detail}
                  </p>
                ))}
              </div>
            )}
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => goLog({date: nextSess.date, type: nextSess.type, km: Number(nextSess.km), pace: nextSess.pace, wNum: nextSess.wNum, sId: nextSess.id})}
                className="flex-1 flex items-center justify-center gap-1.5 bg-orange-500 hover:bg-orange-600 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">
                <Plus size={15}/>{t("dashboard.session.record")}
              </button>
              <button
                onClick={() => toggleSess(nextSess.wNum, nextSess.id)}
                className="flex items-center justify-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors">
                <Check size={15}/>{t("common.done")}
              </button>
              <button
                onClick={() => skipSess(nextSess.wNum, nextSess.id)}
                className="flex items-center justify-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-slate-400 hover:text-slate-200 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                title={t("dashboard.session.skipTitle")}>
                <X size={15}/>{t("common.skip")}
              </button>
            </div>
          </div>
        </div>
      ) : !plan ? (
        <div className="bg-slate-800 rounded-xl p-5 text-center space-y-3">
          <p className="text-slate-400 text-sm">{t("dashboard.noPlan")}</p>
          <button
            onClick={() => goTab("plan")}
            className="bg-orange-500 hover:bg-orange-600 text-white px-6 py-2.5 rounded-xl font-semibold text-sm transition-colors">
            {t("dashboard.setUpPlan")}
          </button>
        </div>
      ) : (
        <div className="bg-slate-800 rounded-xl p-4 text-center text-slate-400 text-sm">{t("dashboard.allSessionsDone")}</div>
      )}

      {plan && (
        <button onClick={() => openCoach(null, "dashboard")}
          className="w-full bg-slate-800 rounded-xl p-3.5 flex items-center gap-3 text-left hover:bg-slate-700/70 transition-colors">
          <CoachAvatar chip size={18}/>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">{t("dashboard.coach.title")}</p>
            <p className="text-xs text-slate-400">{t("dashboard.coach.subtitle")}</p>
          </div>
          <ChevronRight size={16} className="text-slate-600 flex-shrink-0"/>
        </button>
      )}

      {runs.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-slate-500 text-xs uppercase tracking-widest">{t("dashboard.recentRuns")}</p>
            {runs.length > 3 && (
              <button onClick={() => goProgress("log")}
                className="text-xs text-orange-400 hover:text-orange-300 flex items-center gap-0.5 transition-colors">
                {t("dashboard.viewAll")}<ChevronRight size={13}/>
              </button>
            )}
          </div>
          <div className="space-y-2">
            {runs.slice(0, 3).map(r => <RunRow key={r.id} run={r} onClick={openRunDetail ? () => openRunDetail(r) : undefined}/>)}
          </div>
        </div>
      )}

      {!runs.length && (
        <div className="bg-slate-800 rounded-xl p-6 text-center space-y-2">
          <Activity size={32} className="mx-auto text-slate-700"/>
          <p className="text-sm text-slate-400">{t("dashboard.empty.noRuns")}</p>
          <p className="text-xs text-slate-400">{t("dashboard.empty.hint")}</p>
          {!plan && (
            <p className="text-xs text-slate-400 pt-2 border-t border-slate-700/50">
              {t("dashboard.empty.restore")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
