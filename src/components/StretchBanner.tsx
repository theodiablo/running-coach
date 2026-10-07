import { useTranslation } from "react-i18next";
import { PersonStanding, X } from "lucide-react";
import { ROUTINES, cooldownFor } from "../stretch/routines";
import { routineMinutes } from "../utils/stretchEngine";
import type { StretchSuggestion } from "../utils/stretchSuggest";

type StretchBannerProps = {
  suggestion: StretchSuggestion;
  onStart: () => void;
  onDismiss: () => void;
};

// Home's one-line stretch suggestion, in the same row shape as the recovery and
// live-share banners. Which one, and when: utils/stretchSuggest.ts.
export function StretchBanner({ suggestion: s, onStart, onDismiss }: StretchBannerProps) {
  const { t } = useTranslation();
  const km = s.km.toFixed(1);
  const title = s.routine === "cooldown"
    ? t("stretch.banner.cooldownTitle", { min: routineMinutes(cooldownFor(s.focus)) })
    : t("stretch.banner.recoveryTitle", { min: routineMinutes(ROUTINES.recovery) });
  const subtitle = s.routine === "cooldown"
    ? t(s.focus === "hills" ? "stretch.banner.cooldownHills" : s.focus === "hard" ? "stretch.banner.cooldownHard" : "stretch.banner.cooldownStandard", { km })
    : s.race ? t("stretch.banner.recoveryRace") : t("stretch.banner.recoveryLong", { km });
  return (
    <div className="w-full rounded-xl flex items-center border border-teal-500/40 bg-teal-500/10">
      <button onClick={onStart} className="flex-1 min-w-0 p-3.5 pr-2 flex items-center gap-3 text-left rounded-l-xl hover:bg-teal-500/10 transition-colors">
        <PersonStanding size={18} className="text-teal-400 flex-shrink-0"/>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-teal-100">{title}</span>
          <span className="block text-xs text-teal-300/80">{subtitle}</span>
        </span>
        <span className="text-xs font-semibold text-teal-200 flex-shrink-0">{t("stretch.banner.start")}</span>
      </button>
      <button onClick={onDismiss} aria-label={t("stretch.banner.notToday")} title={t("stretch.banner.notToday")}
        className="self-stretch px-3 text-teal-300/70 hover:text-teal-100 rounded-r-xl">
        <X size={16}/>
      </button>
    </div>
  );
}
