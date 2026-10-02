import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import { RecorderSheet, Segmented, SheetLabel, Stepper } from "../components/RecorderSheet";
import { ToggleSwitch } from "../components/ToggleSwitch";
import { fmt } from "../utils/format";
import { BAND_MAX, BAND_MIN, CALLOUT_FREQS, HR_WARNS, type AudioPrefs, type CalloutParts } from "../utils/callout";

// How the coach TALKS about today's run (docs/guided-workouts.md). It has no
// targets of its own: pace and heart rate come from the workout, which this
// sheet only links back to.

export function AudioGuideSheet({ on, prefs, pace, hr, hasHrSensor, sample, onToggle, onPrefs, onEditWorkout, onHear, onClose }: {
  on: boolean;
  prefs: AudioPrefs;
  pace: number | null;
  hr: { lo: number; hi: number } | null;
  hasHrSensor: boolean;
  sample: string;
  onToggle: () => void;
  onPrefs: (prefs: AudioPrefs) => void;
  onEditWorkout: () => void;
  onHear: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<AudioPrefs>) => onPrefs({ ...prefs, ...patch });
  const targets = [pace ? `${fmt.pace(pace)} /km` : "", hr ? t("tracker.audio.heartRange", { lo: hr.lo, hi: hr.hi }) : ""].filter(Boolean).join(" · ");
  const hrWarnUsable = !!hr && hasHrSensor;
  const parts: (keyof CalloutParts)[] = ["pace", "hr", "dist", "left"];

  return (
    <RecorderSheet title={t("tracker.audio.title")} onClose={onClose}
      headerRight={<ToggleSwitch on={on} onToggle={onToggle} label={t("tracker.audio.title")} />}>
      {!on ? (
        <p className="py-6 text-center text-sm text-slate-400">{t("tracker.audio.offBody")}</p>
      ) : (
        <>
          <div className="rounded-xl bg-slate-900 px-3 py-2.5 text-xs text-slate-300 space-y-1">
            <p>{targets ? t("tracker.audio.against", { targets }) : t("tracker.audio.noTargets")}</p>
            <button onClick={onEditWorkout} className="font-semibold text-orange-300 underline">
              {t(targets ? "tracker.audio.changeRun" : "tracker.audio.addTarget")}
            </button>
          </div>

          <SheetLabel>{t("tracker.audio.every")}</SheetLabel>
          <Segmented label={t("tracker.audio.every")} value={prefs.freq} onChange={freq => set({ freq })}
            options={CALLOUT_FREQS.map(f => ({ value: f, label: f === "km" ? t("tracker.audio.eachKm") : f >= 120 ? `${f / 60} min` : `${f} s` }))} />
          <p className="text-xs text-slate-400">{t("tracker.audio.stepsAlways")}</p>

          <SheetLabel>{t("tracker.audio.leeway")}</SheetLabel>
          <Stepper name={t("tracker.audio.leewayName")} muted={!pace}
            value={pace ? `± ${prefs.band} s` : t("tracker.audio.noPace")}
            onStep={dir => set({ band: Math.min(BAND_MAX, Math.max(BAND_MIN, prefs.band + dir * 5)) })} />

          <SheetLabel>{t("tracker.audio.hrWarn")}</SheetLabel>
          <Segmented label={t("tracker.audio.hrWarn")} value={prefs.hrWarn} disabled={!hrWarnUsable}
            onChange={hrWarn => set({ hrWarn })}
            options={HR_WARNS.map(w => ({ value: w, label: t("tracker.audio.hrWarnOpt." + w) }))} />
          <p className="text-xs text-slate-400">
            {!hasHrSensor ? t("tracker.audio.hrNeedsSensor") : !hr ? t("tracker.audio.hrNeedsTarget") : t("tracker.audio.hrRightAway")}
          </p>

          <SheetLabel>{t("tracker.audio.readOut")}</SheetLabel>
          <div className="flex flex-wrap gap-2">
            {parts.map(k => (
              <button key={k} aria-pressed={prefs.say[k]} onClick={() => set({ say: { ...prefs.say, [k]: !prefs.say[k] } })}
                className={"rounded-full border px-3 py-1 text-xs font-semibold transition-colors "
                  + (prefs.say[k] ? "border-orange-500/60 bg-orange-500/15 text-orange-200" : "border-slate-600 text-slate-400")}>
                {t("tracker.audio.part." + k)}
              </button>
            ))}
          </div>
          <div className="flex items-start gap-2 rounded-xl bg-slate-900 px-3 py-2.5">
            <p className="flex-1 text-xs italic text-slate-300">{sample ? `“${sample}”` : t("tracker.audio.nothingSelected")}</p>
            <button onClick={onHear} disabled={!sample}
              className="flex items-center gap-1 rounded-lg border border-slate-600 px-2 py-1 text-xs font-semibold text-slate-200 disabled:opacity-50">
              <Play size={12} />{t("tracker.audio.hear")}
            </button>
          </div>
        </>
      )}
    </RecorderSheet>
  );
}
