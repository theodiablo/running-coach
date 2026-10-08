import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PersonStanding } from "lucide-react";
import { StretchHistory } from "../modals/StretchHistory";
import { stretchSummary } from "../utils/stretchSuggest";
import type { StretchLogEntry } from "../utils/stretchSuggest";

/** Stretching in Progress → Stats: its own card, never folded into the running totals (docs/stretching.md). */
export function StretchStatsCard({ log, days }: { log: StretchLogEntry[]; days: number | null }) {
  const { t } = useTranslation();
  const [history, setHistory] = useState(false);
  const { count, sec, weeks } = stretchSummary(log, new Date(), days);
  const perWeek = Math.round((count / weeks) * 10) / 10;
  return (
    <div className="bg-slate-800 rounded-2xl p-4 space-y-2">
      <div className="flex items-center gap-2">
        <PersonStanding size={16} className="text-teal-400"/>
        <p className="flex-1 text-slate-400 text-sm font-medium">{t("stretch.stats.title")}</p>
      </div>
      <div className="flex items-baseline gap-3">
        <p className="text-2xl font-bold text-teal-300">{t("stretch.history.sessions", { count })}</p>
        {count > 0 && <p className="text-xs text-slate-400">{t("stretch.sheet.minutes", { count: Math.max(1, Math.round(sec / 60)) })}</p>}
      </div>
      <p className="text-xs text-slate-400">{t("stretch.stats.perWeek", { n: perWeek.toLocaleString() })} · {t("stretch.sheet.weekAim")}</p>
      <button onClick={() => setHistory(true)} className="text-xs font-semibold text-teal-300 hover:text-teal-200 transition-colors">
        {t("stretch.stats.seeHistory")}
      </button>
      {history && <StretchHistory log={log} onClose={() => setHistory(false)}/>}
    </div>
  );
}
