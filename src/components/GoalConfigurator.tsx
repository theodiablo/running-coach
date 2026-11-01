import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fmt, parseDur } from "../utils/format";
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

  // Local text for the editable Time / Pace fields. `null` means "not editing,
  // show the derived value"; while a field is focused we let it hold whatever
  // the user is typing (including an empty string) and only commit on blur/Enter
  // — committing an unparseable value is a no-op so the field reverts.
  const [timeText, setTimeText] = useState<string | null>(null);
  const [paceText, setPaceText] = useState<string | null>(null);

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

  // Commit a typed time (total finish time) or pace (per km), clamping into the
  // distance-appropriate band so manual entry stays as realistic as the slider.
  const commitTime = () => {
    const sec = parseDur(timeText);
    if (sec != null) onChange(clampGoalSec(sec, dist));
    setTimeText(null);
  };
  const commitPace = () => {
    const p = parseDur(paceText);
    if (p != null) onChange(clampGoalSec(Math.round(p * dist), dist));
    setPaceText(null);
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
        <label className="flex-1">
          <span className="text-[11px] text-slate-400 block mb-1">{t("onboarding.goal.time")}</span>
          <input type="text" inputMode="numeric" className={fieldCls}
            value={timeText ?? fmt.dur(eff)}
            onChange={e => setTimeText(e.target.value)}
            onFocus={e => e.target.select()}
            onBlur={commitTime}
            onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}/>
        </label>
        <label className="flex-1">
          <span className="text-[11px] text-slate-400 block mb-1">{t("onboarding.goal.pace")}</span>
          <input type="text" inputMode="numeric" className={fieldCls}
            value={paceText ?? fmt.pace(pace)}
            onChange={e => setPaceText(e.target.value)}
            onFocus={e => e.target.select()}
            onBlur={commitPace}
            onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}/>
        </label>
      </div>
    </div>
  );
}
