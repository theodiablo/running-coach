import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { HistoryView } from "./HistoryView";
import { StatsView } from "./StatsView";
import { Badge } from "../components/Badge";
import { computeBadges } from "../utils/badges";
import type { RacesState, Run, SettingsState, RunPatch, RunHighlight } from "../types";

// "Progress" merges the former History + Stats tabs and adds Badges, under a
// segmented toggle. Each sub-view is the existing component, unchanged.
const TABS = [["log", "progress.tabs.log"], ["stats", "progress.tabs.stats"], ["badges", "progress.tabs.badges"]];
type ProgressSub = "log" | "stats" | "badges";
type ProgressViewProps = {
  runs: Run[];
  races: RacesState | null;
  settings: SettingsState;
  initialSub?: ProgressSub;
  navKey?: number;
  deleteRun: (id: string) => void;
  updateRun: (id: string, patch: RunPatch) => void;
  goTab?: (tab: string) => void;
  openRunDetail?: (run: Run) => void;
  highlight?: RunHighlight | null;
};

export function ProgressView(props: ProgressViewProps) {
  const { t } = useTranslation();
  const { runs, races, initialSub, navKey } = props;
  const [sub, setSub] = useState<ProgressSub>(initialSub || "log");
  // Re-apply the requested sub-tab whenever we're navigated here (navKey bumps),
  // even if it's the same target as last time. Render-time sync, not an effect.
  const [prevKey, setPrevKey] = useState(navKey);
  if (navKey !== prevKey) { setPrevKey(navKey); setSub(initialSub || "log"); }
  const badges = useMemo(() => computeBadges(runs, races?.participations || []), [runs, races]);
  const unlocked = badges.filter(b => b.unlocked).length;

  return (
    <div>
      <div className="max-w-lg mx-auto px-4 pt-4">
        <div className="flex bg-slate-800 rounded-xl p-1 gap-1">
          {TABS.map(([id, label]) => (
            <button key={id} onClick={() => setSub(id as ProgressSub)}
              className={"flex-1 py-1.5 rounded-lg text-sm font-semibold transition-colors " +
                (sub === id ? "bg-orange-500 text-white" : "text-slate-400 hover:text-slate-200")}>
              {t(label)}
            </button>
          ))}
        </div>
      </div>

      {sub === "log" && <HistoryView {...props}/>}
      {sub === "stats" && <StatsView {...props}/>}
      {sub === "badges" && (
        <div className="max-w-lg mx-auto p-4">
          <div className="mt-2 mb-4">
            <h2 className="text-xl font-bold">{t("progress.badges.title")}</h2>
            <p className="text-slate-400 text-xs mt-0.5">{t("progress.badges.earned", { unlocked, total: badges.length })}</p>
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            {badges.map(b => <Badge key={b.id} badge={b}/>)}
          </div>
          <p className="text-slate-500 text-xs text-center mt-5">
            {t("progress.badges.hint")}
          </p>
        </div>
      )}
    </div>
  );
}
