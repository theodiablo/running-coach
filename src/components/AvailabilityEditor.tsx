import { useTranslation } from "react-i18next";
import { Minus, Plus } from "lucide-react";
import { fmt } from "../utils/format";
import { SessionConfigurator } from "./SessionConfigurator";
import {
  weeklyLoad, loadBands, clampDays, AVAIL_DAY_MIN, AVAIL_DAY_MAX,
  type AvailabilityMode, type DurationBand,
} from "../utils/availability";
import { suggestPlanSessions } from "../utils/planStyles";
import type { PlanSessionInput } from "../utils/plan";

const BANDS: DurationBand[] = ["short", "med", "long"];

type AvailabilityEditorProps = {
  mode: AvailabilityMode;
  days: number;
  band: DurationBand;
  sessions: PlanSessionInput[];
  distanceKm: number | string;
  // Self-reported training level — sizes the Custom-mode coach-pick chips.
  trainingLevel?: unknown;
  onDaysChange: (n: number) => void;
  onBandChange: (b: DurationBand) => void;
  onSessionsChange: (s: PlanSessionInput[]) => void;
};

// Body of the redesigned "Your availability" section: a beginner-friendly Simple
// mode (day count + duration band, coach places the days) and a Custom mode (exact
// days + durations), both feeding a weekly-load meter that says whether the time
// budget is sensible for the race distance.
export function AvailabilityEditor({
  mode, days, band, sessions, distanceKm, trainingLevel,
  onDaysChange, onBandChange, onSessionsChange,
}: AvailabilityEditorProps) {
  const { t } = useTranslation();
  const dist = Math.round(Number(distanceKm) || 0);
  const load = mode === "simple"
    ? weeklyLoad({ mode: "simple", days: clampDays(days), band, distanceKm })
    : weeklyLoad({ mode: "custom", sessions, distanceKm });

  // Coach-pick chips: the one distance/level-aware day-layout suggestion
  // (suggestPlanSessions), not a fixed layout — the legend names the distance.
  const recommend: Record<number, number> = Object.fromEntries(
    suggestPlanSessions(distanceKm, trainingLevel).map(s => [s.dayOffset, s.minutes]));

  const dayHint = days <= 3 ? "few" : days === 4 ? "solid" : "lots";
  const bands = loadBands(distanceKm);
  const loPct = (bands.goodLo / bands.maxMin) * 100;
  const hiPct = (bands.goodHi / bands.maxMin) * 100;
  const verdictClr = load.zone === "good" ? "text-emerald-400" : "text-amber-400";

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-400 leading-relaxed">{t("plan.avail.framing")}</p>

      {mode === "simple" ? (
        <div className="space-y-4">
          {/* Day-count stepper */}
          <div>
            <p className="text-xs text-slate-400 mb-2">{t("plan.avail.simple.daysQuestion")}</p>
            <div className="flex items-center justify-between bg-slate-900/40 rounded-xl p-2">
              <button type="button" onClick={() => onDaysChange(clampDays(days - 1))}
                disabled={days <= AVAIL_DAY_MIN}
                aria-label={t("plan.avail.simple.fewerDays")}
                className="w-9 h-9 rounded-lg bg-slate-700 text-white flex items-center justify-center disabled:opacity-30 hover:bg-slate-600 transition-colors">
                <Minus size={16}/>
              </button>
              <span className="text-orange-400 font-bold text-xl tabular-nums">
                {t("plan.avail.simple.daysCount", { count: clampDays(days) })}
              </span>
              <button type="button" onClick={() => onDaysChange(clampDays(days + 1))}
                disabled={days >= AVAIL_DAY_MAX}
                aria-label={t("plan.avail.simple.moreDays")}
                className="w-9 h-9 rounded-lg bg-slate-700 text-white flex items-center justify-center disabled:opacity-30 hover:bg-slate-600 transition-colors">
                <Plus size={16}/>
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-1.5 leading-snug">{t("plan.avail.simple.dayHint." + dayHint)}</p>
          </div>

          {/* Duration band cards */}
          <div>
            <p className="text-xs text-slate-400 mb-2">{t("plan.avail.simple.timeQuestion")}</p>
            <div className="grid grid-cols-3 gap-2">
              {BANDS.map(b => {
                const sel = band === b;
                return (
                  <button key={b} type="button" onClick={() => onBandChange(b)}
                    aria-pressed={sel}
                    className={"rounded-xl px-2 py-3 text-center border transition-colors " +
                      (sel ? "bg-orange-500/15 border-orange-500 text-orange-300" : "bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500")}>
                    <span className="block text-sm font-semibold">{t("plan.avail.simple.band." + b + ".label")}</span>
                    <span className="block text-xs opacity-80 mt-0.5">{t("plan.avail.simple.band." + b + ".sub")}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Summary callout */}
          <div className="rounded-xl bg-orange-500/10 border border-orange-500/25 px-3 py-2.5 text-xs text-orange-200 leading-relaxed">
            {t("plan.avail.simple.summary", {
              count: clampDays(days),
              duration: t("plan.avail.simple.band." + band + ".word"),
            })}
          </div>
        </div>
      ) : (
        <SessionConfigurator sessions={sessions} onChange={onSessionsChange}
          recommend={recommend} legend={t("plan.avail.custom.legend", { dist })}/>
      )}

      {/* Weekly load meter */}
      <div className="pt-4 border-t border-slate-700/50 space-y-2">
        <div className="flex justify-between items-center text-xs">
          <span className="text-slate-400 font-medium">{t("plan.avail.load.label")}</span>
          <span className="text-slate-200 font-semibold tabular-nums">
            {t("plan.avail.load.total", { time: fmt.mins(load.totalMin) })}
          </span>
        </div>
        <div className="relative h-2 rounded-full overflow-hidden bg-slate-800">
          <div className="absolute inset-y-0 left-0 bg-amber-900/40" style={{ width: loPct + "%" }}/>
          <div className="absolute inset-y-0 bg-emerald-900/50" style={{ left: loPct + "%", width: (hiPct - loPct) + "%" }}/>
          <div className="absolute inset-y-0 right-0 bg-amber-900/40" style={{ left: hiPct + "%" }}/>
          <div className="absolute top-[-3px] h-[14px] w-[3px] rounded-full bg-white shadow transition-[left] duration-300"
            style={{ left: "calc(" + load.pct + "% - 1.5px)" }}/>
        </div>
        <div className="flex justify-between text-[10px] text-slate-500">
          <span>{t("plan.avail.load.zone.low")}</span>
          <span className="text-emerald-400">{t("plan.avail.load.zone.good", { dist })}</span>
          <span>{t("plan.avail.load.zone.high")}</span>
        </div>
        <p className={"text-xs leading-snug " + verdictClr}>
          {t("plan.avail.load.verdict." + load.zone, { dist })}
        </p>
      </div>
    </div>
  );
}
