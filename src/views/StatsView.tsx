import { useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { TrendingUp } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, CartesianGrid, ReferenceLine } from "recharts";
import { VERT_COST } from "../constants";
import { fmt, weekKey } from "../utils/format";
import { effectiveMaxHR } from "../utils/hr";
import { riegel, bestEffortAnchor, hrModelAnchor, hrModelUsable } from "../utils/predictions";
import { PredictionsInfo } from "../components/PredictionsInfo";
import { HRZonesCard } from "../components/HRZonesCard";
import type { Run, SettingsState } from "../types";

type StatsViewProps = { runs: Run[]; settings: SettingsState };
type StatCard = { l: string; v: string; s: string; c: string };
type Period = "4w" | "12w" | "all";

export function StatsView({runs, settings}: StatsViewProps) {
  const { t } = useTranslation();
  return (
    <div className="max-w-lg mx-auto">
      <div className="px-4 pt-6 pb-0">
        <h2 className="text-xl font-bold">{t("progress.stats.title")}</h2>
      </div>
      <Overview runs={runs} settings={settings}/>
      <RacePredictions runs={runs} settings={settings}/>
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

  const wkBars = (() => {
    const m: Record<string, number> = {};
    fRuns.forEach(r => {
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
    fRuns.forEach(r => {
      const k = weekKey(r.date);
      m[k] = (m[k] || 0) + (r.elevation || 0);
    });
    return Object.entries(m)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(e => ({d: fmt.sht(e[0]), elev: Math.round(e[1])}));
  })();

  const pLine = fRuns.slice()
    .filter(r => r.km && r.durationSec)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(r => ({d: fmt.sht(r.date), p: Math.round((r.durationSec || 0) / r.km)}));

  const totKm   = fRuns.reduce((s, r) => s + (r.km || 0), 0);
  const pRuns   = fRuns.filter(r => r.km && r.durationSec);
  const avgPace = pRuns.length ? pRuns.reduce((s, r) => s + (r.durationSec || 0) / r.km, 0) / pRuns.length : 0;
  const bestPace = pRuns.filter(r => r.km >= 3).reduce<number | null>((b, r) => {
    const p = (r.durationSec || 0) / r.km;
    return (!b || p < b) ? p : b;
  }, null);
  const hrRuns = fRuns.filter(r => r.hr);
  const avgHR  = hrRuns.length ? hrRuns.reduce((s, r) => s + (r.hr || 0), 0) / hrRuns.length : 0;
  const totElev = fRuns.reduce((s, r) => s + (r.elevation || 0), 0);
  const totTime = fRuns.reduce((s, r) => s + (r.durationSec || 0), 0);

  const stats = [
    {l:t("progress.stats.cards.totalDistance"), v:totKm.toFixed(1) + " km",    s:t("progress.stats.cards.runsCount", {n: fRuns.length}), c:"text-orange-400"},
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

// Project finish times from logged runs.
function RacePredictions({runs, settings}: StatsViewProps) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<Period>("12w");

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

  const best = bestEffortAnchor(fRuns);
  const hr   = hrModelAnchor(fRuns, effMax, restHR, best);
  const hrOk = hrModelUsable(hr);

  // 5 / 10 / 20 km, plus the race-day distance when it isn't already one of them.
  const dists = [5, 10, 20];
  const raceD = Number(settings.distanceKm) || 0;
  if (raceD && !dists.includes(raceD)) dists.push(raceD);
  dists.sort((a, b) => a - b);

  // Climb on the race-day course. Applied only to the race-day row — the other
  // distances stay flat hypotheticals — by projecting to the flat-equivalent
  // distance, the same grade-adjustment used on the input runs.
  const raceGain = settings.raceElevation || 0;

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
          <div className="space-y-3">
            {dists.map(d => {
              // Race-day row carries its course climb; others are flat.
              const isRace = d === raceD;
              const dEq = isRace ? d + VERT_COST * raceGain / 1000 : d;
              const bt = riegel(best.durationSec, best.km, dEq);
              const ht = hrOk ? riegel(hr.durationSec, hr.km, dEq) : null;
              return (
                <div key={d} className="bg-slate-800 rounded-xl p-4">
                  <div className="flex items-baseline justify-between mb-3">
                    <p className="font-semibold">
                      {t("progress.predictions.distanceKm", {d})}
                      {isRace && <span className="ml-2 text-xs text-orange-400 font-normal">{t("progress.predictions.raceDay")}</span>}
                      {isRace && raceGain > 0 && <span className="ml-2 text-xs text-slate-500 font-normal">{t("progress.predictions.inclClimb", {m: Math.round(raceGain)})}</span>}
                    </p>
                  </div>
                  <div className={"grid gap-3 " + (ht ? "grid-cols-2" : "grid-cols-1")}>
                    <div>
                      <p className="text-slate-400 text-xs">{t("progress.predictions.bestEffortEstimate")}</p>
                      <p className="text-2xl font-bold mt-0.5 text-orange-400">{fmt.dur(bt)}</p>
                      <p className="text-slate-400 text-xs">{t("progress.predictions.pacePerKm", {pace: fmt.pace(bt / d)})}</p>
                    </div>
                    {ht && (
                      <div>
                        <p className="text-slate-400 text-xs">{t("progress.predictions.hrEstimate")}</p>
                        <p className="text-2xl font-bold mt-0.5 text-sky-400">{fmt.dur(ht)}</p>
                        <p className="text-slate-400 text-xs">{t("progress.predictions.pacePerKm", {pace: fmt.pace(ht / d)})}</p>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

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
                {t("progress.predictions.hrLocked")}
              </p>
            )}
            <p className="text-slate-400 text-xs">
              {raceGain > 0
                ? t("progress.predictions.gradeNoteClimb", {m: Math.round(raceGain)})
                : t("progress.predictions.gradeNoteFlat")}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
