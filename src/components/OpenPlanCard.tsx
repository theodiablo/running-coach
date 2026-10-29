import { useTranslation } from "react-i18next";
import { Compass } from "lucide-react";
import { fmt } from "../utils/format";
import { useSeenOnScreen } from "../hooks/useSeenOnScreen";
import type { OpenPhaseInfo } from "../utils/planPhase";

// Home's slot for a plan with no race: what the blocks are for, which block the
// runner is in and when the next checkpoint run is. Never counts down to a day.
// docs/training-plan.md ("Open plans and blocks").

type OpenPlanCardProps = {
  info: OpenPhaseInfo;
  distanceKm: number;
  // A wishlisted race inside the plan, if any (the block keeps going around it).
  nextRace: { label: string; distanceKm: number; date: string } | null;
  // The plan was started for the runner, who has not yet seen the notice.
  autoStarted: boolean;
  onNoticeSeen: () => void;
  onChange: () => void;
  onRaces: () => void;
};

export function OpenPlanCard({ info, distanceKm, nextRace, autoStarted, onNoticeSeen, onChange, onRaces }: OpenPlanCardProps) {
  const { t } = useTranslation();
  // Spent when it has really been on screen, not at mount (the card sits above the fold, but not always).
  const noticeRef = useSeenOnScreen<HTMLDivElement>(autoStarted, onNoticeSeen);
  const title = t("dashboard.openPlan.target." + info.target, { km: fmt.km(distanceKm) });
  return (
    <div className="rounded-2xl p-5 border border-orange-500/30"
      style={{ background: "linear-gradient(135deg,rgba(249,115,22,.13),rgba(220,38,38,.13))" }}>
      <p className="text-orange-300 text-xs font-semibold uppercase tracking-widest mb-1">
        {t(info.kind === "block" ? "dashboard.openPlan.eyebrowBlock" : "dashboard.openPlan.eyebrow")}
      </p>
      <p className="font-semibold">{info.light ? t("dashboard.openPlan.light", { target: title }) : title}</p>
      <p className="text-slate-400 text-sm mt-1">
        {info.checkpoint
          ? t("dashboard.openPlan.blockCheckpoint", { block: info.block, date: fmt.date(info.checkpoint) })
          : t("dashboard.openPlan.block", { block: info.block })}
      </p>
      {autoStarted && (
        <div ref={noticeRef} className="mt-3 rounded-xl bg-slate-900/50 p-3 text-xs text-slate-300 leading-snug">
          {t("dashboard.openPlan.autoStarted")}
        </div>
      )}
      {nextRace && (
        <button onClick={onRaces}
          className="w-full text-left mt-3 pt-3 border-t border-orange-500/20 flex justify-between items-center gap-2">
          <span className="text-xs text-slate-300 truncate">
            <span className="text-orange-300/80 font-semibold">{t("dashboard.race.nextUp")}</span>
            {nextRace.label + " · " + fmt.km(nextRace.distanceKm) + " km"}
          </span>
          <span className="text-xs text-slate-400 flex-shrink-0">{fmt.sht(nextRace.date)}</span>
        </button>
      )}
      <button onClick={onChange}
        className="w-full mt-3 flex items-center justify-center gap-1.5 bg-slate-800/70 hover:bg-slate-700/70 text-slate-100 py-2.5 rounded-xl text-sm font-semibold transition-colors">
        <Compass size={15}/>{t(autoStarted ? "dashboard.openPlan.changeAuto" : "dashboard.openPlan.change")}
      </button>
    </div>
  );
}
