import { Heart } from "lucide-react";
import { useTranslation } from "react-i18next";
import { sessionHR } from "../utils/hr";
import type { RunType, SettingsPage, SettingsState } from "../types";

type HRTargetProps = {
  type: RunType | string;
  settings: SettingsState;
  openSettings: (page?: SettingsPage) => void;
};

// Per-session heart-rate target shown on the dashboard and plan rows.
export function HRTarget({type, settings, openSettings}: HRTargetProps) {
  const { t } = useTranslation();
  if (!settings.maxHR) {
    return (
      // Stop propagation: this nudge renders inside tappable cards (plan session
      // rows toggle their notes on body click) and must not trigger the parent.
      <button type="button" onClick={e => { e.stopPropagation(); openSettings("training"); }}
        className="text-xs mt-1 flex items-center gap-1.5 text-amber-300 hover:text-amber-200 transition-colors">
        <Heart size={12}/>{t("common.hrTargetNudge")}
      </button>
    );
  }
  const hr = sessionHR(type, settings);
  if (!hr) return null;
  return (
    <p className="text-xs mt-1 flex items-center gap-1.5 flex-wrap">
      <span className="font-semibold" style={{color:hr.clr}}>{"❤️ " + hr.lo + "–" + hr.hi + " bpm"}</span>
      <span className="text-slate-600">{"· " + t("common.hrRowZone." + type, { defaultValue: hr.label })}</span>
    </p>
  );
}
