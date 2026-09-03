import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Award, CalendarClock, Check, ChevronRight, Link2, PenLine, Play, Radio, Route, RotateCcw, X, Zap } from "lucide-react";
import { TBG, TCLR } from "../constants";
import { track } from "../telemetry";
import type { LiveRunRow } from "../live/publisher";
import { fmt, ymd, estMin, weekStart } from "../utils/format";
import { describeSession } from "../utils/sessionDesc";
import { computeBadges, nextBadge } from "../utils/badges";
import { overdueSessions, nextSession } from "../utils/overdue";
import { planSessionPrefill } from "../utils/plan";
import { candidateRuns, canMoveSessionTo, dayGap, type SavedRun } from "../utils/sessionMatch";
import { sessionSteps } from "../utils/sessionSteps";
import { CoachAvatar } from "../components/CoachAvatar";
import { HRTarget } from "../components/HRTarget";
import { RunRow } from "../components/RunRow";
import { ReconcileSheet } from "../modals/ReconcileSheet";
import { useSeenOnScreen } from "../hooks/useSeenOnScreen";
import { isCrossTraining } from "../types";
import type { CoachSource, Plan, PlanSession, RacesState, Run, RunType, SettingsPage, SettingsState } from "../types";

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
  // Tick a session off naming the run that settled it, optionally re-dating the
  // session to the day that run happened; and its inverse, for Undo.
  linkSess: (weekNumber: number, sessionId: string, runId: string, date?: string) => void;
  unlinkSess: (weekNumber: number, sessionId: string, date?: string) => void;
  openSettings: (page?: SettingsPage) => void;
  openCoach: (session?: null, source?: CoachSource) => void;
  showToast: (msg: string, type?: string, action?: {label: string; onClick: () => void}) => void;
  // Persists the one-time overdue coach explainer as shown (the hub owns the
  // settings flag). Optional so a bare render — and the tests — need not pass it.
  markCoachOverdueIntroSeen?: () => void;
  openRunDetail?: (run: Run) => void;
  // A run this account is recording on another device right now (live
  // sharing). Null whenever there is nothing to follow.
  liveRun?: LiveRunRow | null;
  openLiveWatch?: () => void;
  // An interrupted recording waiting to be resumed/saved (the app was killed
  // mid-run). Opening the tracker surfaces its resume/discard card.
  recovery?: { km: number; startedAt: number | null } | null;
  // Both recorders take an optional {wNum, sId} link so a run saved from a plan
  // session ticks that session off (the shared bag's openTracker/openIndoor).
  openTracker?: (link?: { wNum: number; sId: string }) => void;
  openIndoor?: (link?: { wNum: number; sId: string }) => void;
};

const sessionTypeClass = (type: PlanSession["type"], classes: Record<string, string>) => classes[(type as RunType) || "OTHER"] || classes.OTHER;

// How many overdue rows the card renders before deferring the rest to the plan.
const OVERDUE_SHOWN = 3;

// How long the next-session card stays on its confirmation before advancing.
const CONFIRM_MS = 2500;

// Survives Dashboard remounts so `overdue_shown` counts backlog changes, not
// visits. Session-scoped by design — a fresh app launch reports again.
let lastReportedOverdue: number | null = null;

export function Dashboard({runs, plan, settings, races, goTab, goProgress, goLog, toggleSess, skipSess, linkSess, unlinkSess, openSettings, openCoach, showToast, markCoachOverdueIntroSeen, openRunDetail, liveRun, openLiveWatch, recovery, openTracker, openIndoor}: DashboardProps) {
  const { t, i18n } = useTranslation();
  // "How it unfolds" breakdown on the next-session card (collapsed by default).
  const [showSteps, setShowSteps] = useState(false);
  // Keyed on the language too: computeBadges resolves its strings through t(),
  // so a locale switch must recompute even though runs/races are unchanged.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- computeBadges resolves labels via t()
  const nb = useMemo(() => nextBadge(computeBadges(runs, races?.participations || [])), [runs, races, i18n.language]);
  const today    = new Date(); today.setHours(0,0,0,0);
  const raceD    = new Date(settings.raceDate + "T00:00:00");
  const daysLeft = Math.max(0, Math.ceil((raceD.getTime() - today.getTime()) / 86400000));
  // The soonest secondary race folded into the plan before the main race — a
  // checkpoint to flag under the main-race countdown.
  const todayStr = ymd(today);
  const nextRace = (races?.participations || [])
    .filter(p => p.status === "wishlist" && p.inPlan && p.raceDate && p.raceDate >= todayStr && p.raceDate < settings.raceDate)
      .sort((a, b) => String(a.raceDate).localeCompare(String(b.raceDate)))[0];
  // Both selectors carry the week number so the cards' actions can target the
  // right session via openTracker / goLog / toggleSess.
  const nextSess = nextSession(plan, today) as DashboardSession | null;
  const nextIsToday = nextSess && nextSess.date === ymd(today);
  // A session dated in the future can't already be done — ungated, the card
  // refilled under the same button and a repeated tap ticked off sessions weeks
  // out. Ran it early? "Log it" saves the run and ticks the session.
  const canMarkDone = !!nextSess && nextSess.date <= todayStr;
  // Runs already in the log that could BE this session — the answer to "I ran
  // Thursday's tempo on Wednesday", which no amount of date-gating can give.
  // Proposed only: nothing links until the sheet is confirmed.
  const [reconciling, setReconciling] = useState<DashboardSession | null>(null);
  // Recomputed per render rather than memoised: `today` and the selectors above
  // are rebuilt every render anyway, so a dep array would never hold. Each call
  // is one pass over `runs`.
  const nextCandidates = nextSess ? candidateRuns(plan, nextSess, runs) : [];
  const reconcileOptions = reconciling ? candidateRuns(plan, reconciling, runs) : [];
  // Sessions the runner never got to. Only the freshest few are rendered — a
  // month away must not come back as a wall of guilt.
  const overdue = overdueSessions(plan, today) as DashboardSession[];
  const overdueShown = overdue.slice(0, OVERDUE_SHOWN);
  // The headline case one day later: a session missed on Thursday, run on
  // Wednesday, is still the same run waiting to be named. Without this the only
  // action left on it is the evidence-free tick this whole feature replaces.
  const overdueLinkable = new Set(
    overdueShown.filter(s => candidateRuns(plan, s, runs).length).map(s => s.id));

  // Report the backlog once per size change. The last-reported value is module
  // scope, NOT a ref: Dashboard remounts on every tab switch and on the header
  // brand-mark reset (homeNonce), and a per-component ref would re-fire on each
  // one — inflating the very metric this feature will be judged on.
  const overdueCount = overdue.length;
  useEffect(() => {
    if (!overdueCount || overdueCount === lastReportedOverdue) return;
    lastReportedOverdue = overdueCount;
    track("overdue_shown", {count: overdueCount});
  }, [overdueCount]);
  // A tick is a plan edit, not a checkbox: it lands on a confirmation card with
  // Undo and no action row, so a double-tap can't consume the next session.
  // `advanced` re-fires the enter animation once it settles — a silent refill in
  // place read as nothing having happened.
  // `link` is set when the tick named a run: undo then has to release the run
  // and put back whatever date the session carried, so it can't be the same
  // call again the way toggleSess/skipSess are.
  type Confirmed = {wNum: number; sId: string; title: string; meta: string; skipped: boolean; link?: {prevDate: string}};
  const [confirmed, setConfirmed] = useState<Confirmed | null>(null);
  const [advanced, setAdvanced] = useState(0);
  const confirmTimer = useRef<number | null>(null);
  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);

  const holdConfirmation = (c: Confirmed) => {
    setConfirmed(c);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => { setConfirmed(null); setAdvanced(n => n + 1); }, CONFIRM_MS);
  };

  const settleSess = (sess: DashboardSession, skipped: boolean) => {
    (skipped ? skipSess : toggleSess)(sess.wNum, sess.id);
    holdConfirmation({wNum: sess.wNum, sId: sess.id, title: describeSession(sess), skipped,
      meta: t("dashboard.session.confirm.meta", {date: fmt.sht(sess.date)})});
  };

  // "I already ran this": the tick names the run that settled the session, and
  // optionally moves the session to the day it actually happened.
  const reconcileSess = (sess: DashboardSession, run: SavedRun, moveTo: string | null) => {
    setReconciling(null);
    track("session_reconciled", {moved: !!moveTo, gap: Math.abs(dayGap(run.date, sess.date))});
    linkSess(sess.wNum, sess.id, run.id, moveTo || undefined);
    holdConfirmation({wNum: sess.wNum, sId: sess.id, title: describeSession(sess), skipped: false,
      link: {prevDate: sess.date},
      meta: t("dashboard.session.confirm.metaRun", {
        date: fmt.sht(run.date),
        detail: isCrossTraining(run) ? fmt.dur(run.durationSec) : t("dashboard.session.confirm.runDetail", {km: run.km, dur: fmt.dur(run.durationSec)}),
      })});
  };

  const undoConfirmed = () => {
    if (!confirmed) return;
    if (confirmed.link) unlinkSess(confirmed.wNum, confirmed.sId, confirmed.link.prevDate);
    // toggleSess/skipSess are their own inverse, so undo is the same call again.
    else (confirmed.skipped ? skipSess : toggleSess)(confirmed.wNum, confirmed.sId);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmed(null);
  };


  // The first backlog an account ever sees carries a line on what the coach can
  // do about it — the moment the capability is worth believing. Captured at
  // mount so marking it seen can't yank the copy out from under the reader; the
  // flag then keeps it from ever returning. It is spent when it has really been
  // on screen, not at mount: this card sits well down the page, so a Home visit
  // that never scrolled would otherwise burn it unread.
  const [showOverdueCoachIntro] = useState(settings.coachOverdueIntroSeen === false);
  const overdueCoachIntroRef = useSeenOnScreen<HTMLDivElement>(
    showOverdueCoachIntro && overdueCount > 0,
    () => markCoachOverdueIntroSeen?.(),
  );
  const wkMon = weekStart(today);
  // Running kilometres only: a cross-training session's distance is not one
  // (docs/indoor-sessions.md), and these tiles are read as training volume.
  const runOnly = runs.filter(r => !isCrossTraining(r));
  const wkKm  = runOnly.filter(r => new Date(r.date + "T00:00:00") >= wkMon).reduce((s, r) => s + (r.km||0), 0);
  const totKm = runOnly.reduce((s, r) => s + (r.km||0), 0);

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

      {overdueShown.length > 0 && (
        <div className="rounded-2xl border border-amber-400/30 bg-amber-400/5 p-4">
          <div className="flex items-start gap-2.5">
            <CalendarClock size={18} className="text-amber-300 flex-shrink-0 mt-0.5"/>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-amber-100">{t("dashboard.overdue.title", {count: overdue.length})}</p>
              <p className="text-xs text-slate-400 mt-0.5 leading-snug">{t("dashboard.overdue.subtitle")}</p>
            </div>
          </div>
          {showOverdueCoachIntro && (
            <div ref={overdueCoachIntroRef} className="mt-3 flex items-start gap-2.5 rounded-xl bg-slate-900/60 p-3">
              <CoachAvatar chip size={13} className="w-6 h-6 mt-0.5"/>
              <p className="text-xs text-slate-400 leading-snug">{t("dashboard.overdue.coachIntro")}</p>
            </div>
          )}
          <div className="mt-3 space-y-2">
            {overdueShown.map(s => (
              <div key={s.id} className="flex items-center gap-2 rounded-xl bg-slate-800/70 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className={"text-[11px] font-bold uppercase tracking-wide " + sessionTypeClass(s.type, TCLR)}>
                    {t("common.types." + s.type, {defaultValue: s.type})}
                  </p>
                  <p className="text-xs text-slate-300 truncate">{describeSession(s)}</p>
                  <p className="text-[11px] text-slate-500">{fmt.sht(s.date) + " · " + s.km + " km"}</p>
                </div>
                {overdueLinkable.has(s.id) && (
                  <button
                    onClick={() => setReconciling(s)}
                    aria-label={t("dashboard.session.alreadyRan")} title={t("dashboard.session.alreadyRan")}
                    className="flex-shrink-0 p-2 rounded-lg border border-orange-500/40 bg-orange-500/10 hover:bg-orange-500/20 text-orange-200 transition-colors">
                    <Link2 size={15}/>
                  </button>
                )}
                <button
                  onClick={() => {
                    track("overdue_resolved", {action: "done"});
                    toggleSess(s.wNum, s.id);
                    showToast(t("dashboard.overdue.markedDone"), "ok", {label: t("common.undo"), onClick: () => toggleSess(s.wNum, s.id)});
                  }}
                  aria-label={t("common.done")} title={t("common.done")}
                  className="flex-shrink-0 p-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
                  <Check size={15}/>
                </button>
                <button
                  onClick={() => {
                    track("overdue_resolved", {action: "skip"});
                    skipSess(s.wNum, s.id);
                    showToast(t("dashboard.overdue.markedSkipped"), "ok", {label: t("common.undo"), onClick: () => skipSess(s.wNum, s.id)});
                  }}
                  aria-label={t("common.skip")} title={t("dashboard.session.skipTitle")}
                  className="flex-shrink-0 p-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-400 hover:text-slate-200 transition-colors">
                  <X size={15}/>
                </button>
              </div>
            ))}
          </div>
          {overdue.length > overdueShown.length && (
            <button onClick={() => goTab("plan")}
              className="mt-2 flex items-center gap-0.5 text-xs text-slate-400 hover:text-slate-200 transition-colors">
              {t("dashboard.overdue.more", {count: overdue.length - overdueShown.length})}<ChevronRight size={13}/>
            </button>
          )}
          <button
            onClick={() => { track("overdue_resolved", {action: "coach"}); openCoach(null, "dashboard"); }}
            className="w-full mt-3 flex items-center justify-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-slate-100 py-2.5 rounded-xl text-sm font-semibold transition-colors">
            <CoachAvatar chip size={15}/>{t("dashboard.overdue.adjust")}
          </button>
        </div>
      )}

      {confirmed ? (
        <div>
          <p className="text-emerald-300 text-xs font-bold uppercase tracking-widest mb-2">
            {t("dashboard.session.confirm.kicker")}
          </p>
          <div className="border-2 border-emerald-500/40 bg-emerald-500/10 rounded-2xl p-4 animate-slide-up">
            <div className="flex items-center gap-3">
              <span className="w-8 h-8 rounded-full bg-emerald-500 text-slate-900 flex items-center justify-center flex-shrink-0 animate-pop" aria-hidden>
                <Check size={17} strokeWidth={3}/>
              </span>
              <div className="min-w-0" role="status">
                <p className="text-sm text-white leading-snug">
                  {t(confirmed.skipped ? "dashboard.session.confirm.skipped" : "dashboard.session.confirm.done", {title: confirmed.title})}
                </p>
                <p className="text-xs text-slate-400 mt-0.5">{confirmed.meta}</p>
              </div>
            </div>
            <div className="flex justify-center mt-3">
              <button onClick={undoConfirmed}
                className="flex items-center gap-1.5 text-xs font-semibold text-emerald-300 hover:text-emerald-200 transition-colors">
                <RotateCcw size={13}/>{t("common.undo")}
              </button>
            </div>
          </div>
        </div>
      ) : nextSess ? (
        <div>
          <p className="text-orange-300 text-xs font-bold uppercase tracking-widest mb-2">
            {nextIsToday ? t("dashboard.session.today") : t("dashboard.session.upNext")}
          </p>
          <div key={"sess-" + advanced}
            className={"border-2 rounded-2xl p-4 " + (advanced ? "animate-slide-up " : "") + sessionTypeClass(nextSess.type, TBG)}>
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
            {/* Same two verbs, same wiring as the plan row (PlanSessionRow):
                Start run opens the recorder, Log it fills in a run already done.
                Ticking off without logging anything stays available, quieter. */}
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => (nextSess.type === "OTHER" ? openIndoor : openTracker)?.({ wNum: nextSess.wNum, sId: nextSess.id })}
                className="flex-1 flex items-center justify-center gap-1.5 bg-orange-500 hover:bg-orange-600 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">
                <Play size={15}/>{t("dashboard.session.startRun")}
              </button>
              <button
                onClick={() => goLog(planSessionPrefill(nextSess, nextSess.wNum))}
                className="flex items-center justify-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors">
                <PenLine size={15}/>{t("dashboard.session.logIt")}
              </button>
            </div>
            <div className="flex gap-4 mt-2.5 justify-center">
              {canMarkDone && (
                <button
                  onClick={() => settleSess(nextSess, false)}
                  className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors">
                  <Check size={13}/>{t("dashboard.session.markDone")}
                </button>
              )}
              <button
                onClick={() => settleSess(nextSess, true)}
                className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors"
                title={t("dashboard.session.skipTitle")}>
                <X size={13}/>{t("common.skip")}
              </button>
            </div>
            {/* Ran it already, on some other day? Name the run instead of being
                told to come back tomorrow. */}
            {nextCandidates.length > 0 ? (
              <button onClick={() => setReconciling(nextSess)}
                className="mt-2.5 w-full py-2 rounded-xl border border-orange-500/40 bg-orange-500/10 hover:bg-orange-500/20 text-orange-200 text-xs font-semibold transition-colors">
                {t("dashboard.session.alreadyRan")}
              </button>
            ) : !canMarkDone && (
              <p className="mt-2.5 text-center text-xs text-slate-500 leading-snug">
                {t("dashboard.session.markDoneLocked", {date: fmt.sht(nextSess.date)})}
              </p>
            )}
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

      {reconciling && (
        <ReconcileSheet
          session={reconciling}
          runs={reconcileOptions}
          canMoveTo={date => canMoveSessionTo(plan, reconciling.wNum, date)}
          onConfirm={(runId, moveTo) => {
            const run = reconcileOptions.find(r => r.id === runId);
            if (run) reconcileSess(reconciling, run, moveTo);
          }}
          onClose={() => setReconciling(null)}/>
      )}
    </div>
  );
}
