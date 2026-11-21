import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fmt } from "../utils/format";
import { durToSec, secToDur } from "../utils/runForm";
import { DurationInput } from "./DurationInput";
import { paceBand, suggestedGoalSec, clampGoalSec } from "../utils/goal";

// Goal-setting control shared by onboarding and the plan view: a slider plus editable Time / Pace fields.
// The range adapts to the distance; changing the distance resets the goal to a fresh suggestion so a time
// picked for one race length never lingers on another.
type GoalConfiguratorProps = {
  distanceKm: number | string;
  goalSec: number | string;
  onChange: (goalSec: number | string) => void;
};

export function GoalConfigurator({distanceKm, goalSec, onChange}: GoalConfiguratorProps) {
  const { t } = useTranslation();
  const dist = parseFloat(String(distanceKm));
  const band = paceBand(dist);
  const suggested = suggestedGoalSec(dist);

  // When the distance is unset/out-of-band we fill a suggestion, otherwise we
  // clamp an existing goal into the distance-appropriate range. The distance
  // change itself is handled in the effect below.
  const normalised = band ? (goalSec ? clampGoalSec(Number(goalSec), dist) : suggested) : goalSec;

  // Push the normalised value up to the parent (never setState during render).
  // A change in distance always re-suggests rather than carrying the old goal
  // over — otherwise a time picked for one race length lingers on another (a
  // 5 km time left sitting on a 20 km race).
  const prevDist = useRef(distanceKm);
  useEffect(() => {
    const distChanged = prevDist.current !== distanceKm;
    prevDist.current = distanceKm;
    if (!band) return;
    if (distChanged && suggested != null) onChange(suggested);
    else if (normalised != null && normalised !== goalSec) onChange(normalised);
  }, [band, distanceKm, suggested, normalised, goalSec, onChange]);

  // Digits being typed in Time / Pace; `null` shows the derived value. Committed on blur/Enter.
  const [timeDigits, setTimeDigits] = useState<string | null>(null);
  const [paceDigits, setPaceDigits] = useState<string | null>(null);

  if (!band) {
    return (
      <div>
        <label className="text-xs text-slate-400 block mb-1.5">{t("onboarding.goal.label")}</label>
        <div className="bg-slate-800/60 border border-dashed border-slate-700 rounded-xl p-3 text-xs text-slate-400">
          {t("onboarding.goal.needDistance")}
        </div>
      </div>
    );
  }

  const eff   = Number(normalised) || suggested || 0;
  const pace  = Math.round(eff / dist);
  const tMin  = Math.round(band.fast * dist);
  const tMax  = Math.round(band.slow * dist);

  // A typed time or pace clamps into the distance's band, like the slider; an empty field reverts.
  // An untouched field commits nothing: pace is rounded, so re-deriving the goal from it would drift.
  const commitTime = (digits: string) => {
    if (timeDigits == null) return;
    const sec = durToSec(digits);
    if (sec > 0) onChange(clampGoalSec(sec, dist));
    setTimeDigits(null);
  };
  const commitPace = (digits: string) => {
    if (paceDigits == null) return;
    const p = durToSec(digits);
    if (p > 0) onChange(clampGoalSec(Math.round(p * dist), dist));
    setPaceDigits(null);
  };

  const fieldCls = "w-full bg-slate-700 border border-slate-600 rounded-lg px-2 py-1.5 text-white text-sm text-center tabular-nums focus:outline-none focus:border-orange-400";

  return (
    <div>
      <label className="text-xs text-slate-400 block mb-1.5">{t("onboarding.goal.label")}</label>
      <input type="range" min={tMin} max={tMax} step={10} value={eff}
        onChange={e => onChange(parseInt(e.target.value, 10))}
        className="w-full accent-orange-500"/>
      <div className="flex justify-between text-xs text-slate-400 mt-1">
        <span>{fmt.dur(tMin)}</span><span>{fmt.dur(tMax)}</span>
      </div>
      <div className="flex gap-2 mt-3">
        <label className="flex-1 min-w-0">
          <span className="text-[11px] text-slate-400 block mb-1">{t("onboarding.goal.time")}</span>
          <DurationInput className={fieldCls} value={timeDigits ?? secToDur(eff)}
            onChange={setTimeDigits} onCommit={commitTime} selectOnFocus/>
        </label>
        <label className="flex-1 min-w-0">
          <span className="text-[11px] text-slate-400 block mb-1">{t("onboarding.goal.pace")}</span>
          <DurationInput className={fieldCls} value={paceDigits ?? secToDur(pace)}
            onChange={setPaceDigits} onCommit={commitPace} selectOnFocus/>
        </label>
      </div>
    </div>
  );
}
