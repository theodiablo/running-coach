// One "your fastest 5K was 24:31" line. Shared by the post-run reward sheet and
// the run detail card so a rank reads identically wherever it's surfaced.

import { useTranslation } from "react-i18next";
import { fmt } from "../utils/format";
import { isFirstEffort, isPersonalBest, type EffortRank } from "../utils/bestEfforts";

export function EffortRow({ effort }: { effort: EffortRank }) {
  const { t } = useTranslation();

  // A first-ever effort is rank 1 of 1 — true, but "fastest ever" would be an
  // empty boast, so it gets its own honest wording.
  const first = isFirstEffort(effort);
  const pb = isPersonalBest(effort);
  // Ranks below the top three carry no badge, just the standing best to chase.
  // Spelled out rather than built from the rank so every key stays a literal the
  // dangling-key test can check — and so raising ACHIEVEMENT_MAX_RANK fails here
  // loudly instead of rendering a raw key.
  const badge = first ? t("bestEfforts.badge.first")
    : pb ? t("bestEfforts.badge.pb")
    : effort.rank === 2 ? t("bestEfforts.badge.rank2")
    : effort.rank === 3 ? t("bestEfforts.badge.rank3")
    : "";
  const sub = pb && effort.gainSec && effort.gainSec > 0
    ? t("bestEfforts.faster", { delta: fmt.dur(effort.gainSec) })
    : !pb && !first && effort.previousBest
      ? t("bestEfforts.standingBest", { dur: fmt.dur(effort.previousBest.sec), date: fmt.sht(effort.previousBest.date) })
      : null;

  return (
    <div className="flex items-center justify-between gap-3 bg-slate-900/60 rounded-xl px-3 py-2">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-white truncate">{t("bestEfforts.dist." + effort.key)}</p>
        {sub && <p className="text-xs text-slate-400 truncate">{sub}</p>}
      </div>
      <div className="text-right shrink-0">
        <p className="text-sm font-bold tabular-nums text-white">{fmt.dur(effort.sec)}</p>
        {badge && <p className={"text-xs font-medium " + (pb ? "text-emerald-400" : first ? "text-orange-300" : "text-slate-400")}>{badge}</p>}
      </div>
    </div>
  );
}
