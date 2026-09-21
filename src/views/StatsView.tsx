import { useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { TrendingUp } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, CartesianGrid, ReferenceLine } from "recharts";
import { VERT_COST } from "../constants";
import { fmt, weekKey, ymd } from "../utils/format";
import { effectiveMaxHR } from "../utils/hr";
import { riegel, bestEffortAnchor, hrModelAnchor, hrModelUsable, hrModelBlocker, hrModelGap } from "../utils/predictions";
import { raceTargets, goalGap } from "../utils/raceTargets";
import { findEdition } from "../utils/races";
import { PredictionsInfo } from "../components/PredictionsInfo";
import { HRZonesCard } from "../components/HRZonesCard";
import { isCrossTraining } from "../types";
import type { RacesState, Run, SettingsState } from "../types";

type StatsViewProps = {
  runs: Run[];
  settings: SettingsState;
  races?: RacesState | null;
  goTab?: (tab: string) => void;
};
type StatCard = { l: string; v: string; s: string; c: string };
type Period = "4w" | "12w" | "all";

export function StatsView(props: StatsViewProps) {
  const { t } = useTranslation();
  const { runs, settings } = props;
  return (
    <div className="max-w-lg mx-auto">
      <div className="px-4 pt-6 pb-0">
        <h2 className="text-xl font-bold">{t("progress.stats.title")}</h2>
      </div>
      <Overview runs={runs} settings={settings}/>
      <RacePredictions {...props}/>
      <HRZonesCard runs={runs} settings={settings}/>
    </div>
  );
}

function Overview({runs, settings}: StatsViewProps) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<Period>("12w");
  // The user's goal pace, drawn on the pace trend so the reference line tracks
  // their actual target rather than a hardcoded 6:00.
  const goalPace = settings && settings.goalSec && settings.distanceKm
    ? Number(settings.goalSec) / Number(settings.distanceKm) : 0;

  const fRuns = period === "all" ? runs : (() => {
    const cut = new Date();
    cut.setDate(cut.getDate() - (period === "4w" ? 28 : 84));
    return runs.filter(r => new Date(r.date + "T00:00:00") >= cut);
  })();

  // Everything on this screen except total TIME is a running measure: distance,
  // pace, elevation, the trends, the run count and the average HR. A
  // cross-training session has no comparable distance or pace, and its heart
  // rate — real, but achieved without impact and at a different economy — would
  // read as a change in running fitness that never happened. Time is the one
  // honest common denominator, so it alone still counts every session.
  // See docs/indoor-sessions.md.
  const runOnly = fRuns.filter(r => !isCrossTraining(r));

  const wkBars = (() => {
    const m: Record<string, number> = {};
    runOnly.forEach(r => {
      const k = weekKey(r.date);
      m[k] = (m[k] || 0) + (r.km || 0);
    });
    return Object.entries(m)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(e => ({d: fmt.sht(e[0]), km: Math.round(e[1] * 10) / 10}));
  })();

  // Weekly elevation gain, bucketed the same way as weekly distance so the two
  // charts share a timeline. Weeks with runs but no elevation contribute 0.
  const wkElevBars = (() => {
    const m: Record<string, number> = {};
    runOnly.forEach(r => {
      const k = weekKey(r.date);
      m[k] = (m[k] || 0) + (r.elevation || 0);
    });
    return Object.entries(m)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(e => ({d: fmt.sht(e[0]), elev: Math.round(e[1])}));
  })();

  const pLine = runOnly.slice()
    .filter(r => r.km && r.durationSec)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(r => ({d: fmt.sht(r.date), p: Math.round((r.durationSec || 0) / r.km)}));

  const totKm   = runOnly.reduce((s, r) => s + (r.km || 0), 0);
  const pRuns   = runOnly.filter(r => r.km && r.durationSec);
  const avgPace = pRuns.length ? pRuns.reduce((s, r) => s + (r.durationSec || 0) / r.km, 0) / pRuns.length : 0;
  const bestPace = pRuns.filter(r => r.km >= 3).reduce<number | null>((b, r) => {
    const p = (r.durationSec || 0) / r.km;
    return (!b || p < b) ? p : b;
  }, null);
  const hrRuns = runOnly.filter(r => r.hr);
  const avgHR  = hrRuns.length ? hrRuns.reduce((s, r) => s + (r.hr || 0), 0) / hrRuns.length : 0;
  const totElev = runOnly.reduce((s, r) => s + (r.elevation || 0), 0);
  // The one measure that counts every session: an hour on the bike is an hour
  // of training, whatever the legs were doing.
  const totTime = fRuns.reduce((s, r) => s + (r.durationSec || 0), 0);

  const stats = [
    {l:t("progress.stats.cards.totalDistance"), v:totKm.toFixed(1) + " km",    s:t("progress.stats.cards.runsCount", {n: runOnly.length}), c:"text-orange-400"},
    {l:t("progress.stats.cards.totalTime"),     v:(totTime/3600).toFixed(1) + " h", s:t("progress.stats.cards.movingTime"),     c:"text-violet-400"},
    {l:t("progress.stats.cards.averagePace"),   v:fmt.pace(avgPace),             s:t("progress.stats.cards.minPerKm"),               c:"text-sky-400"},
    totElev > 0 && {l:t("progress.stats.cards.totalElevation"), v:Math.round(totElev).toLocaleString() + " m", s:t("progress.stats.cards.climbed"), c:"text-emerald-400"},
    bestPace && {l:t("progress.stats.cards.bestPace"),     v:fmt.pace(bestPace), s:t("progress.stats.cards.bestPaceSub"),            c:"text-amber-400"},
    avgHR > 0 && {l:t("progress.stats.cards.avgHeartRate"), v:Math.round(avgHR) + "", s:t("progress.stats.cards.bpm"),           c:"text-red-400"},
  ].filter((s): s is StatCard => Boolean(s));

  const tt = {background:"#1e293b", border:"none", borderRadius:8, color:"#fff", fontSize:12};

  if (!runs.length) return (
    <div className="flex flex-col items-center justify-center pt-20 text-center gap-3 p-4">
      <TrendingUp size={48} className="text-slate-700"/>
      <p className="text-slate-400">{t("progress.stats.empty")}</p>
    </div>
  );

  return (
    <div className="p-4 space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-slate-400 text-xs">{t("progress.stats.totalsCaption")}</p>
        <div className="flex bg-slate-800 rounded-xl p-1 gap-0.5">
          {(["4w","12w","all"] as const).map(p => (
            <button key={p} onClick={() => setPeriod(p)}
              className={"text-xs px-3 py-1.5 rounded-lg transition-colors " + (period === p ? "bg-orange-500 text-white" : "text-slate-400 hover:text-white")}>
              {t("progress.stats.period." + p)}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {stats.map(s => (
          <div key={s.l} className="bg-slate-800 rounded-xl p-4">
            <p className="text-slate-400 text-xs">{s.l}</p>
            <p className={"text-2xl font-bold mt-1 " + s.c}>{s.v}</p>
            <p className="text-slate-400 text-xs">{s.s}</p>
          </div>
        ))}
      </div>
      {wkBars.length > 1 && (
        <div className="bg-slate-800 rounded-2xl p-4">
          <p className="text-slate-400 text-sm font-medium mb-3">{t("progress.stats.weeklyDistance")}</p>
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={wkBars} margin={{top:0,right:4,left:-18,bottom:0}}>
              <CartesianGrid strokeDasharray="3 3" stroke="#0f172a"/>
              <XAxis dataKey="d" tick={{fill:"#475569",fontSize:10}}/>
              <YAxis tick={{fill:"#475569",fontSize:10}}/>
              <Tooltip contentStyle={tt} formatter={v => [t("progress.stats.tooltip.km", {v: String(v)}), t("progress.stats.tooltip.distance")]}/>
              <Bar dataKey="km" fill="#f97316" radius={[4,4,0,0]}/>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {totElev > 0 && wkElevBars.length > 1 && (
        <div className="bg-slate-800 rounded-2xl p-4">
          <p className="text-slate-400 text-sm font-medium mb-3">{t("progress.stats.weeklyElevation")}</p>
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={wkElevBars} margin={{top:0,right:4,left:-18,bottom:0}}>
              <CartesianGrid strokeDasharray="3 3" stroke="#0f172a"/>
              <XAxis dataKey="d" tick={{fill:"#475569",fontSize:10}}/>
              <YAxis tick={{fill:"#475569",fontSize:10}}/>
              <Tooltip contentStyle={tt} formatter={v => [t("progress.stats.tooltip.m", {v: String(v)}), t("progress.stats.tooltip.elevation")]}/>
              <Bar dataKey="elev" fill="#10b981" radius={[4,4,0,0]}/>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {pLine.length > 2 && (
        <div className="bg-slate-800 rounded-2xl p-4">
          <div className="flex justify-between items-baseline mb-3">
            <p className="text-slate-400 text-sm font-medium">{t("progress.stats.paceTrend")}</p>
            <p className="text-slate-400 text-xs">{t("progress.stats.downFaster")}</p>
          </div>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={pLine} margin={{top:4,right:4,left:-18,bottom:0}}>
              <CartesianGrid strokeDasharray="3 3" stroke="#0f172a"/>
              <XAxis dataKey="d" tick={{fill:"#475569",fontSize:10}}/>
              <YAxis tick={{fill:"#475569",fontSize:10}} domain={["dataMin - 30","dataMax + 30"]}
                tickFormatter={v => fmt.pace(Number(v))}/>
              <Tooltip contentStyle={tt} formatter={v => [t("progress.stats.tooltip.perKm", {v: fmt.pace(Number(v))}), t("progress.stats.tooltip.pace")]}/>
              {goalPace > 0 && (
                <ReferenceLine y={Math.round(goalPace)} stroke="#f97316" strokeDasharray="5 3"
                  label={{value: t("progress.stats.goalLabel", {pace: fmt.pace(goalPace)}), fill:"#f97316", fontSize:10, position:"right"}}/>
              )}
              <Line type="monotone" dataKey="p" stroke="#38bdf8" strokeWidth={2.5}
                dot={{r:3.5, fill:"#38bdf8", strokeWidth:0}}/>
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// One locked-state line per gate the HR model can fail, so a runner who has been
// logging for months is told which kind of data is missing.
const HR_LOCKED_COPY: Record<NonNullable<ReturnType<typeof hrModelBlocker>>, string> = {
  noData:  "progress.predictions.hrLockedNoData",
  few:     "progress.predictions.hrLockedFew",
  spread:  "progress.predictions.hrLockedSpread",
  flat:    "progress.predictions.hrLockedFlat",
  scatter: "progress.predictions.hrLockedScatter",
};

// The two estimates side by side — shared by a race card and a ladder row, so
// the HR column appears or disappears in one place rather than two.
function EstimatePair({bt, ht, km}: {bt: number; ht: number | null; km: number}) {
  const { t } = useTranslation();
  return (
    <div className={"grid gap-3 " + (ht ? "grid-cols-2" : "grid-cols-1")}>
      <div>
        <p className="text-slate-400 text-xs">{t("progress.predictions.bestEffortEstimate")}</p>
        <p className="text-2xl font-bold mt-0.5 text-orange-400">{fmt.dur(bt)}</p>
        <p className="text-slate-400 text-xs">{t("progress.predictions.pacePerKm", {pace: fmt.pace(bt / km)})}</p>
      </div>
      {ht && (
        <div>
          <p className="text-slate-400 text-xs">{t("progress.predictions.hrEstimate")}</p>
          <p className="text-2xl font-bold mt-0.5 text-sky-400">{fmt.dur(ht)}</p>
          <p className="text-slate-400 text-xs">{t("progress.predictions.pacePerKm", {pace: fmt.pace(ht / km)})}</p>
        </div>
      )}
    </div>
  );
}

// "1:01 over" / "3:20 to spare" — the direction stated, never a bare signed number.
const gapLabel = (diffSec: number, t: (k: string, v?: Record<string, unknown>) => string) =>
  Math.abs(diffSec) < 30
    ? t("progress.predictions.gapLevel")
    : t("progress.predictions." + (diffSec > 0 ? "gapOver" : "gapUnder"), {d: fmt.dur(Math.abs(diffSec))});

// Project finish times from logged runs.
function RacePredictions({runs, settings, races, goTab}: StatsViewProps) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<Period>("12w");
  const [showLadder, setShowLadder] = useState(false);

  // Same period filter the Overview uses, so both halves of Stats agree.
  const fRuns = period === "all" ? runs : (() => {
    const cut = new Date();
    cut.setDate(cut.getDate() - (period === "4w" ? 28 : 84));
    return runs.filter(r => new Date(r.date + "T00:00:00") >= cut);
  })();

  // Effective max HR: explicit setting → Tanaka from age → highest HR observed.
  const effMax = effectiveMaxHR(settings)
    || fRuns.reduce((m, r) => Math.max(m, r.hrMax || r.hr || 0), 0);
  const restHR = settings.restHR || 60;

  // Predictions are about running fitness: a cross-training session's distance
  // and its HR at a different economy must not anchor either model.
  const pRuns = fRuns.filter(r => !isCrossTraining(r));
  const best = bestEffortAnchor(pRuns);
  const hr   = hrModelAnchor(pRuns, effMax, restHR, best);
  const hrOk = hrModelUsable(hr);

  // The runner's own upcoming races come first; the ladder below is the general
  // picture, always flat, and collapsed while there are real races to look at.
  const today = ymd(new Date());
  const targets = raceTargets(races?.participations, settings, today,
    id => (findEdition(id)?.edition?.elevation ?? null) as number | null);
  const LADDER = [5, 10, 20];

  // Grade-adjusted target distance: each metre of climb costs VERT_COST flat
  // metres, the same adjustment applied to the runs feeding both models.
  const project = (km: number, gain: number) => {
    const dEq = km + VERT_COST * gain / 1000;
    return {
      bt: best ? riegel(best.durationSec, best.km, dEq) : 0,
      ht: hrOk && best ? riegel(hr.durationSec, hr.km, dEq) : null,
    };
  };

  const countdown = (d: number) => d <= 0
    ? t("progress.predictions.raceToday")
    : d === 1 ? t("progress.predictions.raceTomorrow") : t("progress.predictions.inDays", {n: d});

  if (!runs.length) return null;

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-bold">{t("progress.predictions.title")}</h3>
            <PredictionsInfo/>
          </div>
          <p className="text-slate-400 text-xs mt-0.5">{t("progress.predictions.subtitle")}</p>
        </div>
        <div className="flex bg-slate-800 rounded-xl p-1 gap-0.5">
          {(["4w","12w","all"] as const).map(p => (
            <button key={p} onClick={() => setPeriod(p)}
              className={"text-xs px-3 py-1.5 rounded-lg transition-colors " + (period === p ? "bg-orange-500 text-white" : "text-slate-400 hover:text-white")}>
              {t("progress.stats.period." + p)}
            </button>
          ))}
        </div>
      </div>

      {!best ? (
        <div className="bg-slate-800 rounded-xl p-4 text-center">
          <p className="text-slate-400 text-sm">{t("progress.predictions.needRun")}</p>
        </div>
      ) : (
        <>
          {targets.length > 0 && (
            <div className="space-y-3">
              <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide">{t("progress.predictions.racesHeading")}</p>
              {targets.map(target => {
                const {bt, ht} = project(target.distanceKm, target.elevation);
                const gap = goalGap(settings, target, bt);
                const hrGap = ht != null ? goalGap(settings, target, ht) : null;
                return (
                  <div key={target.key} className={"bg-slate-800 rounded-xl p-4 space-y-3" + (target.isGoal ? " border border-orange-500/40" : "")}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold">{target.label || t("progress.predictions.yourRace")}</p>
                          {target.isGoal && <span className="text-[10px] font-bold tracking-wide bg-orange-500 text-white rounded px-1.5 py-0.5">{t("progress.predictions.goalRace")}</span>}
                        </div>
                        <p className="text-slate-400 text-xs mt-1">
                          {fmt.sht(target.date)} · {t("progress.predictions.distanceKm", {d: target.distanceKm})}
                          {target.elevationKnown && target.elevation > 0 && " · +" + Math.round(target.elevation) + " m"}
                        </p>
                      </div>
                      <span className={"flex-shrink-0 text-xs font-semibold rounded-lg px-2 py-1 " + (target.daysAway <= 14 ? "bg-amber-500/15 text-amber-400" : "bg-slate-700/60 text-slate-300")}>
                        {countdown(target.daysAway)}
                      </span>
                    </div>

                    <EstimatePair bt={bt} ht={ht} km={target.distanceKm}/>

                    {gap && (
                      <div className="rounded-lg bg-amber-500/10 p-3 space-y-1">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-amber-400 text-xs">{t("progress.predictions.goalLabel")}</span>
                          <span className="text-amber-400 font-bold">{fmt.dur(gap.goalSec)}</span>
                        </div>
                        <p className="text-amber-400/90 text-xs leading-relaxed">
                          {t("progress.predictions.goalBest", {gap: gapLabel(gap.diffSec, t)})}
                          {hrGap && " " + t("progress.predictions.goalHr", {gap: gapLabel(hrGap.diffSec, t)})}
                        </p>
                      </div>
                    )}

                    {!target.elevationKnown && (
                      <div className="rounded-lg bg-amber-500/10 p-3 flex items-center gap-3">
                        <p className="text-amber-400 text-xs leading-relaxed flex-1">{t("progress.predictions.climbUnknown")}</p>
                        {target.isGoal && goTab && (
                          <button onClick={() => goTab("plan")} className="flex-shrink-0 text-xs font-semibold text-amber-400 border border-amber-500/40 rounded-lg px-2.5 py-1.5">
                            {t("progress.predictions.addClimb")}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {targets.length > 0 ? (
            <button onClick={() => setShowLadder(v => !v)} aria-expanded={showLadder}
              className="w-full flex items-center justify-between rounded-xl border border-slate-700 px-4 py-3 text-sm font-semibold text-slate-300">
              <span>{t("progress.predictions.otherDistances")}</span>
              <span className="text-slate-400 text-lg leading-none">{showLadder ? "−" : "+"}</span>
            </button>
          ) : null}

          {(targets.length === 0 || showLadder) && (
            <div className="space-y-3">
              {LADDER.map(d => {
                const {bt, ht} = project(d, 0);
                return (
                  <div key={d} className="bg-slate-800 rounded-xl p-4">
                    <p className="font-semibold mb-3">{t("progress.predictions.distanceKm", {d})}</p>
                    <EstimatePair bt={bt} ht={ht} km={d}/>
                  </div>
                );
              })}
            </div>
          )}

          <div className="bg-slate-800/50 rounded-xl p-4 space-y-2">
            <p className="text-slate-400 text-xs">
              <Trans i18nKey="progress.predictions.bestEffortExplainer"
                values={{run: (best.raw.elevation || 0) > 0
                  ? t("progress.predictions.runSummaryClimb", {km: best.raw.km, dur: fmt.dur(best.durationSec), climb: Math.round(best.raw.elevation || 0)})
                  : t("progress.predictions.runSummary", {km: best.raw.km, dur: fmt.dur(best.durationSec)})}}
                components={[<span className="text-orange-400 font-semibold"/>]}/>
            </p>
            {hrOk ? (
              <p className="text-slate-400 text-xs">
                <Trans i18nKey={"progress.predictions." + (hr.capped ? "hrExplainerCapped" : "hrExplainer")}
                  values={{n: hr.n, thr: hr.atHR, full: hr.thrHR}}
                  components={[<span className="text-sky-400 font-semibold"/>]}/>
              </p>
            ) : (
              <p className="text-slate-500 text-xs">
                {t(HR_LOCKED_COPY[hrModelBlocker(hr) ?? "noData"], hrModelGap(hr))}
              </p>
            )}
            <p className="text-slate-400 text-xs">{t("progress.predictions.gradeNote")}</p>
          </div>
        </>
      )}
    </div>
  );
}
