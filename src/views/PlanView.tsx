import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { dayName } from "../i18n";
import { fmt } from "../utils/format";
import { runnerAge } from "../utils/hr";
import { secondaryRaces } from "../utils/races";
import { routeSuggestEnabled } from "../constants";
import { canShowPremiumTeaser } from "../premium";
import { GoalConfigurator } from "../components/GoalConfigurator";
import { PlanInfo } from "../components/PlanInfo";
import { StylePicker } from "../components/StylePicker";
import { AvailabilityEditor } from "../components/AvailabilityEditor";
import { PlanSessionRow } from "../components/PlanSessionRow";
import { styleMeta, isStyleId, recommendStyle, stylePacing, type StyleId } from "../utils/planStyles";
import { sessionsFromSimple, clampDays, isBand, type AvailabilityMode, type DurationBand } from "../utils/availability";
import type { CoachSessionContext, CoachSource, Plan, PlanPrefill, PlanWeek, RacesState, Run, SettingsState } from "../types";
import { carryProgress, type BuildPlanOptions, type PlanSessionInput } from "../utils/plan";
import { overdueByWeek } from "../utils/overdue";

// ── Week windows ────────────────────────────────────────────────────────────
// A plan week owns [startDate, startDate + 7). Weeks are contiguous, so
// `weekEnd <= today` partitions the plan cleanly into behind / current+ahead.
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const weekStart = (w: PlanWeek) => new Date((w.startDate || "") + "T00:00:00");
const weekEnd   = (w: PlanWeek) => { const e = weekStart(w); e.setDate(e.getDate() + 7); return e; };

// The plan list shows weeks still ahead first and pushes finished ones to the
// bottom, so "now" is always at the top without having to scroll to it.
const splitWeeks = (plan: Plan | null) => {
  const today = startOfToday();
  const weeks = plan?.weeks || [];
  return {
    upcoming: weeks.filter(w => weekEnd(w) > today),
    past:     weeks.filter(w => weekEnd(w) <= today),
  };
};

// The week we auto-expand and label "week n of m": the current one, else the
// next one up (plan not started yet), else the last (race already run).
const focusWeek = (plan: Plan | null): number | null => {
  const { upcoming, past } = splitWeeks(plan);
  return upcoming[0]?.weekNumber ?? past[past.length - 1]?.weekNumber ?? null;
};

type PlanViewProps = {
  plan: Plan | null;
  settings: SettingsState;
  runs: Run[];
  races: RacesState | null;
  savePlan: (plan: Plan) => void;
  saveSettings: (settings: SettingsState) => void;
  buildPlan: (
    raceDate: string,
    goalSec: number | string,
    planSessions: PlanSessionInput[],
    distanceKm: number | string,
    raceElevation: number | string,
    opts?: BuildPlanOptions,
  ) => Plan;
  toggleSess: (weekNumber: number, sessionId: string) => void;
  skipSess: (weekNumber: number, sessionId: string) => void;
  openSettings: () => void;
  openCoach: (session?: CoachSessionContext | null, source?: CoachSource) => void;
  openTracker: (link?: { wNum: number; sId: string; findRouteKm?: number }) => void;
  goLog: (prefill: Partial<Run>) => void;
  showToast: (msg: string, type?: string) => void;
  planPrefill?: PlanPrefill | null;
  clearPlanPrefill?: () => void;
  // "Find a route" is premium-only; free users reach the teaser inside the
  // tracker, except on iOS where the entry point is hidden entirely.
  isPremium?: boolean;
};

type PlanDraftValue = string | number;
type EditSection = "goal" | "avail" | "style" | null;

export function PlanView({plan, settings, runs, races, savePlan, saveSettings, buildPlan, toggleSess, skipSess, openSettings, openCoach, openTracker, goLog, showToast, planPrefill, clearPlanPrefill, isPremium = false}: PlanViewProps) {
  const { t } = useTranslation();

  // Plan-card / edit-screen summary strings. Closures so they capture `t`
  // directly rather than threading i18next's overloaded TFunction through helpers.
  const goalSummaryOf = (dist: unknown, goalSec: unknown, elev: number, date: string): string =>
    t(Number(goalSec) ? "plan.goalRow.summary" : "plan.goalRow.summaryNoGoal", {
      dist: Number(dist) || 0,
      goal: fmt.dur(Number(goalSec) || 0),
      date: fmt.sht(date),
      elev: elev > 0 ? " · +" + Math.round(elev) + " m" : "",
    });
  const goalDraftSummary = (dist: number | string, goalSec: number | string, date: string, elev: number | string): string =>
    (!dist || !date) ? t("plan.notConfigured") : goalSummaryOf(dist, goalSec, Number(elev) || 0, String(date));
  const availDraftSummary = (mode: AvailabilityMode, days: number, band: DurationBand, sessions: PlanSessionInput[]): string =>
    mode === "simple"
      ? t("plan.availRow.simpleSummary", { days: clampDays(days), duration: t("plan.avail.simple.band." + band + ".word") })
      : sessions.slice().sort((a, b) => a.dayOffset - b.dayOffset).map(s => dayName(s.dayOffset) + " " + fmt.mins(s.minutes)).join(" · ");
  // Expanded week, by weekNumber — not by list position, which past-weeks-last
  // reordering makes meaningless.
  const [exp,          setExp]         = useState<number | null>(() => focusWeek(plan));
  // Session card expanded to its coach-notes breakdown (one at a time).
  const [openSess,     setOpenSess]    = useState<string | null>(null);
  // A promote ("Set as target") opens the edit screen pre-filled.
  const [editing,      setEditing]     = useState(!!planPrefill);
  // Which accordion section is expanded on the edit screen (one at a time).
  const [editSection,  setEditSection] = useState<EditSection>("goal");

  // ── Edit drafts ─────────────────────────────────────────────────────────
  const [draft,        setDraft]       = useState<PlanSessionInput[]>(settings.planSessions || [{dayOffset:2,minutes:30},{dayOffset:6,minutes:60}]);
  const [draftDate,    setDraftDate]   = useState<string>(planPrefill?.raceDate ?? settings.raceDate);
  const [draftGoal,    setDraftGoal]   = useState<PlanDraftValue>(planPrefill ? "" : settings.goalSec);
  const [draftDist,    setDraftDist]   = useState<PlanDraftValue>(planPrefill?.distanceKm ?? (settings.distanceKm || ""));
  const [draftElev,    setDraftElev]   = useState<PlanDraftValue>(planPrefill?.raceElevation ?? (settings.raceElevation || 0));
  const [draftStyle,   setDraftStyle]  = useState<StyleId | null>(isStyleId(settings.planStyle) ? settings.planStyle : null);
  // Availability mode drafts: metadata only, resolved to concrete sessions on save.
  const [draftMode,    setDraftMode]   = useState<AvailabilityMode>(settings.availabilityMode === "simple" ? "simple" : "custom");
  const [draftDays,    setDraftDays]   = useState<number>(clampDays(Number(settings.availDays) || (settings.planSessions?.length ?? 3)));
  const [draftBand,    setDraftBand]   = useState<DurationBand>(isBand(settings.availTime) ? settings.availTime : "med");

  const recommendedStyle = recommendStyle({
    intent: settings.intent, planSessions: draft, distanceKm: draftDist, recentRuns: runs,
    level: settings.trainingLevel,
    age: runnerAge(settings),
  });
  const effectiveStyle = draftStyle ?? recommendedStyle;
  // The concrete sessions the current draft resolves to (Simple mode synthesises them).
  const resolvedSessions = draftMode === "simple" ? sessionsFromSimple(draftDays, draftBand) : draft;

  // Re-expand the current week whenever the plan changes (e.g. rebuild).
  const [prevPlan, setPrevPlan] = useState<Plan | null>(plan);
  if (plan !== prevPlan) {
    setPrevPlan(plan);
    setExp(focusWeek(plan));
  }

  // A promote ("Set as target") prefills the edit screen with a catalogue edition.
  const [prevPrefill, setPrevPrefill] = useState<PlanPrefill | null | undefined>(planPrefill);
  if (planPrefill !== prevPrefill) {
    setPrevPrefill(planPrefill);
    if (planPrefill) {
      setDraftDate(planPrefill.raceDate);
      setDraftDist(planPrefill.distanceKm);
      setDraftElev(planPrefill.raceElevation || 0);
      setDraftGoal("");
      setEditSection("goal");
      setEditing(true);
    }
  }

  const promoting = !!planPrefill;
  const cancelPromote = () => { clearPlanPrefill?.(); setEditing(false); };

  // Seed every draft from the live settings, then open the edit screen with the
  // tapped section expanded.
  const openEdit = (section: EditSection) => {
    const ps = plan?.planSessions || settings.planSessions || [];
    setDraft(ps.slice());
    setDraftDate(settings.raceDate);
    setDraftGoal(settings.goalSec);
    setDraftDist(settings.distanceKm || "");
    setDraftElev(settings.raceElevation || 0);
    setDraftStyle(isStyleId(settings.planStyle) ? settings.planStyle : null);
    setDraftMode(settings.availabilityMode === "simple" ? "simple" : "custom");
    setDraftDays(clampDays(Number(settings.availDays) || ps.length || 3));
    setDraftBand(isBand(settings.availTime) ? settings.availTime : "med");
    setEditSection(section);
    setEditing(true);
  };

  // Build (or rebuild) the plan from the current drafts and persist everything.
  const genPlan = () => {
    const ps   = resolvedSessions;
    const date = draftDate    || settings.raceDate;
    const goal = draftGoal    || settings.goalSec;
    const dist = draftDist    || settings.distanceKm || 20;
    const elev = draftElev    ?? settings.raceElevation ?? 0;
    // Keep the catalogue link only when building the promoted/target race unchanged.
    const sameAsPrefill = planPrefill && date === planPrefill.raceDate && Number(dist) === Number(planPrefill.distanceKm);
    const sameAsTarget  = date === settings.raceDate && Number(dist) === Number(settings.distanceKm);
    const targetEditionId = sameAsPrefill ? planPrefill.editionId : (sameAsTarget ? (settings.targetEditionId ?? null) : null);
    const style = effectiveStyle;
    const availMeta = draftMode === "simple"
      ? { availabilityMode: "simple" as const, availDays: clampDays(draftDays), availTime: draftBand }
      : { availabilityMode: "custom" as const, availDays: ps.length, availTime: draftBand };
    saveSettings({...settings, planSessions: ps, raceDate: date, goalSec: goal, distanceKm: dist, raceElevation: Number(elev) || 0, targetEditionId, planStyle: style, ...availMeta});
    const secRaces = secondaryRaces(races?.participations || [], targetEditionId);
    const built = buildPlan(date, goal, ps, dist, elev, {recentRuns: runs, races: secRaces, mainEditionId: targetEditionId, style, level: settings.trainingLevel});
    const hadPlan = !!plan;
    // A rebuild keeps done/skipped progress by session id — the on-screen note
    // promises it. A promote is deliberately fresh ("Builds a fresh plan for
    // this race"): carrying week-positional ids across races would mis-tick.
    savePlan(promoting ? built : carryProgress(plan, built));
    setEditing(false);
    clearPlanPrefill?.();
    if (hadPlan) showToast(t("plan.toast.rebuilt", { n: built.weeks.flatMap(w => w.sessions).length }), "ok");
  };

  const canBuild = !!draftDate && !!draftDist;

  // ── Edit / setup screen ───────────────────────────────────────────────────
  if (!plan || editing || promoting) {
    const isSetup = !plan && !promoting;
    const ctaLabel = isSetup ? t("plan.setup.generate") : promoting ? t("plan.setup.buildMyPlan") : t("plan.setup.rebuildMyPlan");
    const modeToggle = (
      <div className="flex bg-slate-800 rounded-lg p-0.5 gap-0.5 flex-shrink-0">
        {(["simple", "custom"] as AvailabilityMode[]).map(m => (
          <button key={m} type="button" onClick={() => setDraftMode(m)} aria-pressed={draftMode === m}
            className={"px-3 py-1 rounded-md text-xs font-semibold transition-colors " +
              (draftMode === m ? "bg-orange-500 text-slate-900" : "text-slate-400 hover:text-slate-200")}>
            {t("plan.avail.mode." + m)}
          </button>
        ))}
      </div>
    );

    return (
      <div className="p-4 max-w-lg mx-auto">
        <div className="flex items-center gap-2.5 mt-4 mb-4">
          {plan && (
            <button onClick={promoting ? cancelPromote : () => setEditing(false)}
              aria-label={t("common.back")}
              className="w-[34px] h-[34px] rounded-lg bg-slate-700 flex items-center justify-center text-slate-300 hover:bg-slate-600 transition-colors flex-shrink-0">
              <ArrowLeft size={18}/>
            </button>
          )}
          <h2 className="text-lg font-bold">{isSetup ? t("plan.title") : t("plan.editPlan")}</h2>
        </div>

        {promoting && planPrefill && <PromoteBanner prefill={planPrefill} onCancel={cancelPromote}/>}
        {isSetup && <p className="text-slate-400 text-sm mb-4">{t("plan.setup.intro")}</p>}

        <div className="space-y-3">
          {/* 1 · Goal */}
          <AccordionSection num={1} title={t("plan.edit.goalTitle")}
            summary={goalDraftSummary(draftDist, draftGoal, draftDate, draftElev)}
            expanded={editSection === "goal"} onToggle={() => setEditSection(editSection === "goal" ? null : "goal")}>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1.5">{t("plan.setup.raceDate")}</label>
                  <input type="date" value={draftDate || ""} onChange={e => setDraftDate(e.target.value)}
                    className="w-full bg-slate-700 border border-slate-600 rounded-xl p-2.5 text-white text-sm focus:outline-none focus:border-orange-400"/>
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1.5">{t("plan.setup.distance")}</label>
                  <input type="number" min="1" max="200" step="0.1" value={draftDist} placeholder={t("plan.setup.distancePlaceholder")}
                    onChange={e => { const n = parseFloat(e.target.value); setDraftDist(isNaN(n) ? "" : n); }}
                    className="w-full bg-slate-700 border border-slate-600 rounded-xl p-2.5 text-white text-sm focus:outline-none focus:border-orange-400 placeholder-slate-500"/>
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1.5">{t("plan.setup.raceElevation")}</label>
                <input type="number" min="0" max="10000" step="10" value={draftElev} placeholder="0"
                  onChange={e => { const v = e.target.value; setDraftElev(v === "" ? "" : Math.max(0, parseInt(v) || 0)); }}
                  className="w-full bg-slate-700 border border-slate-600 rounded-xl p-2.5 text-white text-sm focus:outline-none focus:border-orange-400 placeholder-slate-500"/>
                <p className="text-slate-500 text-xs mt-1">{t("plan.setup.elevationHelp")}</p>
              </div>
              <GoalConfigurator distanceKm={draftDist} goalSec={draftGoal} onChange={setDraftGoal}/>
            </div>
          </AccordionSection>

          {/* 2 · Availability */}
          <AccordionSection num={2} title={t("plan.edit.availTitle")}
            summary={availDraftSummary(draftMode, draftDays, draftBand, draft)}
            expanded={editSection === "avail"} onToggle={() => setEditSection(editSection === "avail" ? null : "avail")}
            headerControl={modeToggle}>
            <AvailabilityEditor mode={draftMode} days={draftDays} band={draftBand} sessions={draft}
              distanceKm={draftDist || settings.distanceKm || 20} trainingLevel={settings.trainingLevel}
              onDaysChange={setDraftDays} onBandChange={setDraftBand} onSessionsChange={setDraft}/>
          </AccordionSection>

          {/* 3 · Training style */}
          <AccordionSection num={3} title={t("plan.edit.styleTitle")}
            summary={styleMeta(effectiveStyle).label}
            expanded={editSection === "style"} onToggle={() => setEditSection(editSection === "style" ? null : "style")}>
            <StylePicker value={effectiveStyle} onChange={setDraftStyle} recommended={recommendedStyle}/>
          </AccordionSection>
        </div>

        {!settings.maxHR && (
          <button type="button" onClick={openSettings}
            className="w-full mt-4 bg-amber-500/10 hover:bg-amber-500/15 border border-amber-500/25 rounded-xl p-3 text-xs text-amber-200 flex gap-2 items-start text-left transition-colors">
            <span className="flex-shrink-0 text-base leading-none">💡</span>
            <span>{t("plan.setup.hrNudge")}</span>
          </button>
        )}

        <button onClick={genPlan} disabled={!canBuild}
          className="w-full mt-4 bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white py-3 rounded-xl font-semibold transition-colors">
          {ctaLabel}
        </button>
        <p className="text-xs text-slate-500 text-center mt-2">
          {promoting ? t("plan.setup.promoteNote") : t("plan.setup.rebuildNote")}
        </p>
      </div>
    );
  }

  // ── Plan screen ─────────────────────────────────────────────────────────
  const all  = plan.weeks.flatMap(w => w.sessions);
  const done = all.filter(s => s.done).length;
  const pct  = Math.round((done / all.length) * 100);
  const today = startOfToday();
  // Same definition of "overdue" the Dashboard card uses, so the two surfaces
  // can never disagree about what is still open (src/utils/overdue.ts).
  const overdueCounts = overdueByWeek(plan, today);
  const { upcoming, past } = splitWeeks(plan);
  const ps   = plan.planSessions || settings.planSessions || [];
  const sessInfo = ps.slice()
    .sort((a, b) => a.dayOffset - b.dayOffset)
    .map(s => dayName(s.dayOffset) + " " + fmt.mins(s.minutes))
    .join(" · ");
  const planStyle: StyleId = isStyleId(plan.style) ? plan.style : "balanced";
  const easyPace = Math.round((plan.targetPace || 0) * stylePacing(planStyle).long);
  const peakLongMin = plan.longRunPeakKm && easyPace ? Math.round(plan.longRunPeakKm * easyPace / 60) : 0;
  const longestSessMin = ps.reduce((m, s) => Math.max(m, s.minutes || 0), 0);
  const longRunNudge = peakLongMin > longestSessMin + 20;

  const weeksTotal = plan.weeks.length;
  // Outside every week window: before the plan starts show week 1, after it
  // ends (race passed) show the final week — never "Week 1" of a finished plan.
  const curWeekNum = focusWeek(plan) ?? 1;
  const raceMs = new Date(String(plan.raceDate || "") + "T00:00:00").getTime();
  const daysToRace = Number.isFinite(raceMs) ? Math.max(0, Math.round((raceMs - today.getTime()) / 86400000)) : 0;

  const goalSummary = goalSummaryOf(plan.distanceKm || 20, plan.goalSec, plan.raceElevation || 0, String(plan.raceDate || ""));
  const availSummary = settings.availabilityMode === "simple" && settings.availDays
    ? t("plan.availRow.simpleSummary", { days: settings.availDays, duration: t("plan.avail.simple.band." + (isBand(settings.availTime) ? settings.availTime : "med") + ".word") })
    : sessInfo;

  const phaseClass = (phase?: string) => {
    if (phase === "TAPER") return "bg-emerald-500/15 text-emerald-400";
    if (phase === "PEAK" || phase === "RACE") return "bg-red-500/15 text-red-400";
    if (phase === "BUILD") return "bg-yellow-500/15 text-yellow-400";
    return "bg-sky-500/15 text-sky-400";
  };

  // One collapsible week card. Rendered twice — once for the weeks still ahead,
  // once for the past ones below them — so it takes the week, not a list index.
  const weekCard = (wk: PlanWeek) => {
    const isPast = weekEnd(wk) <= today;
    const isCurr = !isPast && weekStart(wk) <= today;
    const isExp  = exp === wk.weekNumber;
    const wDone  = wk.sessions.filter(s => s.done).length;
    // Untouched sessions in a week that has already ended — without this a past
    // week nobody ran reads exactly like one that was completed.
    const wOpen  = isPast ? (overdueCounts[wk.weekNumber] || 0) : 0;
    const wkNumCls = isCurr ? "text-orange-400" : isPast ? "text-slate-600" : "text-slate-200";
    const wkCardCls = isCurr ? "border-orange-500/50 bg-orange-500/5" : "border-slate-700/60 bg-slate-800/50";
    const phaseLabel = t("common.phases." + wk.phase, { defaultValue: wk.phase });

    return (
      <div key={wk.weekNumber} className={"rounded-xl border " + wkCardCls}>
        <button onClick={() => setExp(isExp ? null : wk.weekNumber)} className="w-full px-4 py-3 flex items-center gap-2 text-left">
          <span className={"text-[15px] font-bold flex-shrink-0 " + wkNumCls}>{t("plan.week.label", { number: wk.weekNumber })}</span>
          <span className="text-xs text-slate-400 flex-shrink-0">{fmt.sht(wk.startDate || "")}</span>
          <span title={phaseLabel} className={"text-[10.5px] font-semibold px-2 py-0.5 rounded-full min-w-0 truncate " + phaseClass(wk.phase)}>{phaseLabel}</span>
          {isCurr && <span className="text-xs text-orange-400 flex-shrink-0">{t("plan.week.now")}</span>}
          {wOpen > 0 && (
            <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 bg-amber-400/15 text-amber-300">
              {t("plan.week.stillOpen", { count: wOpen })}
            </span>
          )}
          <span className="flex-1"/>
          <span className="text-xs text-slate-400 whitespace-nowrap">{wDone + "/" + wk.sessions.length}</span>
          <ChevronDown size={15} className={"text-slate-500 transition-transform flex-shrink-0 " + (isExp ? "rotate-180" : "")}/>
        </button>

        {isExp && (
          <div className="px-3 pb-3 pt-1 space-y-2 animate-expand">
            {wk.sessions.slice().sort((a, b) => a.date.localeCompare(b.date)).map(s => (
              <PlanSessionRow key={s.id} session={s} settings={settings}
                notesOpen={openSess === s.id}
                onToggleNotes={() => setOpenSess(openSess === s.id ? null : s.id)}
                onRecord={() => openTracker({wNum: wk.weekNumber, sId: s.id})}
                onDone={() => goLog({date: s.date, type: s.type, km: Number(s.km), pace: s.pace, wNum: wk.weekNumber, sId: s.id})}
                onToggleDone={() => toggleSess(wk.weekNumber, s.id)}
                onSkip={() => skipSess(wk.weekNumber, s.id)}
                onAskCoach={() => openCoach({ session: s, weekNumber: wk.weekNumber }, "plan_session")}
                onFindRoute={routeSuggestEnabled && (isPremium || canShowPremiumTeaser) && Number(s.km) > 0
                  ? () => openTracker({ wNum: wk.weekNumber, sId: s.id, findRouteKm: Number(s.km) })
                  : undefined}
                openSettings={openSettings}/>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="p-4 max-w-lg mx-auto">
      {/* No coach button here: it moved to the app header (RunningCoach.tsx) so
          it's reachable from every tab. The per-session "Ask coach" below stays. */}
      <h2 className="text-xl font-bold mt-4 mb-4">{t("plan.title")}</h2>

      {/* Plan card */}
      <div className="rounded-2xl bg-slate-800/70 border border-slate-700/50 divide-y divide-slate-700/40 mb-2.5">
        {/* Progress */}
        <div className="px-4 py-3.5">
          <div className="flex justify-between text-[13px] mb-2">
            <span className="text-slate-200 font-semibold">{t("plan.progress.sessions", {done, total: all.length})}</span>
            <span className="text-orange-400 font-bold">{pct + "%"}</span>
          </div>
          <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
            <div className="h-full bg-orange-500 rounded-full transition-[width] duration-300" style={{width: pct + "%"}}/>
          </div>
          <div className="flex justify-between text-[11px] text-slate-500 mt-2">
            <span>{t("plan.progress.weekOf", {n: curWeekNum, total: weeksTotal})}</span>
            <span>{t("plan.progress.raceIn", {days: daysToRace})}</span>
          </div>
        </div>
        {/* Goal row */}
        <PlanInputRow icon="🎯" tint="bg-orange-500/15" title={t("plan.edit.goalTitle")}
          subtitle={t("plan.goalRow.subtitle")} summary={goalSummary} editLabel={t("plan.editShort")}
          onEdit={() => openEdit("goal")}/>
        {/* Availability row */}
        <PlanInputRow icon="📅" tint="bg-sky-500/15" title={t("plan.edit.availTitle")}
          subtitle={t("plan.availRow.subtitle")} summary={availSummary || t("plan.notConfigured")} editLabel={t("plan.editShort")}
          onEdit={() => openEdit("avail")}/>
      </div>

      <div className="flex items-center justify-between gap-2 mb-3 px-1">
        <p className="text-[11px] text-slate-500 leading-tight">{t("plan.reassurance")}</p>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-700/60 text-slate-300">{styleMeta(planStyle).label}</span>
          <PlanInfo/>
        </div>
      </div>

      {longRunNudge && (
        <div className="w-full mb-3 rounded-xl px-4 py-2.5 text-xs text-amber-200 bg-amber-500/10 border border-amber-500/25 flex gap-2 items-start">
          <span className="flex-shrink-0 text-base leading-none">💡</span>
          <span>{t("plan.longRunNudge", {peak: fmt.mins(peakLongMin), longest: fmt.mins(longestSessMin)})}</span>
        </div>
      )}

      <div className="space-y-2">{upcoming.map(weekCard)}</div>

      {past.length > 0 && (
        <>
          <div className="flex items-center gap-2.5 mt-5 mb-2 px-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{t("plan.pastWeeks")}</span>
            <span className="h-px flex-1 bg-slate-700/60"/>
          </div>
          <div className="space-y-2">{past.map(weekCard)}</div>
        </>
      )}
    </div>
  );
}

// ── Accordion section (edit screen) ─────────────────────────────────────────
// `headerControl` (the availability Simple/Custom switch) renders as a sibling of
// the toggle button, never nested inside it — nested <button>s break click
// handling. Goal/style have no control, so they show the chevron instead.
type AccordionSectionProps = {
  num: number; title: string; summary?: string;
  expanded: boolean; onToggle: () => void; headerControl?: ReactNode; children: ReactNode;
};

function AccordionSection({ num, title, summary, expanded, onToggle, headerControl, children }: AccordionSectionProps) {
  return (
    <div className="rounded-2xl bg-slate-900/50 border border-slate-700/50">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <button onClick={onToggle} className="flex items-center gap-3 flex-1 min-w-0 text-left">
          <span className="w-6 h-6 rounded-full bg-orange-500 text-slate-900 text-xs font-bold flex items-center justify-center flex-shrink-0">{num}</span>
          <span className="font-semibold text-slate-100 text-[15px] flex-shrink-0">{title}</span>
          <span className="flex-1 min-w-0"/>
          {!expanded && summary && <span className="text-xs text-slate-500 truncate min-w-0">{summary}</span>}
          {!(expanded && headerControl) && (
            <ChevronDown size={18} className={"text-slate-500 flex-shrink-0 transition-transform " + (expanded ? "rotate-180" : "")}/>
          )}
        </button>
        {expanded && headerControl}
      </div>
      {expanded && <div className="px-4 pb-4 animate-expand">{children}</div>}
    </div>
  );
}

// ── Plan-card input row (Goal / Availability) ───────────────────────────────
type PlanInputRowProps = {
  icon: string; tint: string; title: string; subtitle: string; summary: string;
  editLabel: string; onEdit: () => void;
};

function PlanInputRow({ icon, tint, title, subtitle, summary, editLabel, onEdit }: PlanInputRowProps) {
  return (
    <button onClick={onEdit} className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-slate-700/30 transition-colors">
      <span className={"w-9 h-9 rounded-[11px] flex items-center justify-center text-lg flex-shrink-0 " + tint}>{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="flex items-baseline gap-1.5">
          <span className="text-[13.5px] font-bold text-slate-100">{title}</span>
          <span className="text-[11px] text-slate-500 truncate">{subtitle}</span>
        </span>
        <span className="block text-[12.5px] text-slate-400 truncate mt-0.5">{summary}</span>
      </span>
      <span className="text-[12px] font-semibold text-orange-400 border border-orange-500/45 bg-orange-500/10 rounded-lg px-3 py-1 flex-shrink-0">{editLabel}</span>
    </button>
  );
}

// Focused header shown when arriving from "Set as target".
type PromoteBannerProps = { prefill: PlanPrefill; onCancel: () => void };

function PromoteBanner({ prefill, onCancel }: PromoteBannerProps) {
  const { t } = useTranslation();
  return (
    <div className="rounded-2xl p-4 mb-4 border border-orange-500/40"
      style={{ background: "linear-gradient(135deg,rgba(249,115,22,.13),rgba(220,38,38,.13))" }}>
      <p className="text-orange-300 text-xs font-semibold uppercase tracking-widest mb-1">{t("plan.promote.newTarget")}</p>
      <p className="font-semibold">{prefill.label || t("plan.promote.yourRace")}</p>
      <p className="text-slate-400 text-sm mt-0.5">
        {fmt.date(prefill.raceDate) + " · " + prefill.distanceKm + " km" + (prefill.raceElevation ? " · +" + prefill.raceElevation + "m" : "")}
      </p>
      <p className="text-slate-300 text-sm mt-2">{t("plan.setup.introPromote")}</p>
      <button onClick={onCancel} className="text-xs text-slate-400 hover:text-slate-200 mt-2 transition-colors">{t("common.cancel")}</button>
    </div>
  );
}
