import { useTranslation } from "react-i18next";
import { ChevronLeft } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";
import { currentLocaleTag } from "../i18n";
import { fmt, weekKey, ymd } from "../utils/format";
import { stretchWeeks } from "../utils/stretchSuggest";
import type { StretchLogEntry } from "../utils/stretchSuggest";

type StretchHistoryProps = {
  log: StretchLogEntry[];
  now?: Date;
  onClose: () => void;
};

const minutes = (sec: number) => Math.max(1, Math.round(sec / 60));

/** The stretch log week by week: a tally per week, never a streak (docs/stretching.md). */
export function StretchHistory({ log, now = new Date(), onClose }: StretchHistoryProps) {
  const { t } = useTranslation();
  useDismissable(true, onClose);
  const thisWeek = weekKey(ymd(now));
  const lastWeekDay = new Date(now);
  lastWeekDay.setDate(lastWeekDay.getDate() - 7);
  const lastWeek = weekKey(ymd(lastWeekDay));
  const weekLabel = (start: string) => start === thisWeek ? t("stretch.history.thisWeek")
    : start === lastWeek ? t("stretch.history.lastWeek") : t("stretch.history.weekOf", { date: fmt.sht(start) });
  const day = (e: StretchLogEntry) => new Date(e.date + "T12:00:00").toLocaleDateString(currentLocaleTag(), { weekday: "short", day: "numeric", month: "short" });
  const time = (e: StretchLogEntry) => new Date(e.at).toLocaleTimeString(currentLocaleTag(), { hour: "numeric", minute: "2-digit" });

  return (
    <div className="fixed inset-0 bg-slate-900 z-[55] flex flex-col animate-slide-up">
      <header className="flex items-center gap-2 px-3 border-b border-slate-800 shrink-0"
        style={{ height: "calc(48px + var(--safe-top))", paddingTop: "var(--safe-top)" }}>
        <button onClick={onClose} aria-label={t("common.back")} className="text-slate-400 hover:text-white p-1.5">
          <ChevronLeft size={20}/>
        </button>
        <span className="flex-1 text-center text-sm font-semibold">{t("stretch.history.title")}</span>
        <span className="w-8"/>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-lg mx-auto p-4 space-y-5" style={{ paddingBottom: "calc(1rem + var(--safe-bottom))" }}>
          {stretchWeeks(log).map(w => (
            <section key={w.start}>
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <h3 className="text-sm font-semibold">{weekLabel(w.start)}</h3>
                <span className="text-xs text-slate-400 tabular-nums">
                  {t("stretch.history.sessions", { count: w.entries.length })} · {t("stretch.sheet.minutes", { count: minutes(w.sec) })}
                </span>
              </div>
              <ul className="divide-y divide-slate-800">
                {w.entries.map(e => (
                  <li key={e.at} className="flex items-center gap-3 py-2">
                    <span className="w-2 h-2 rounded-full bg-teal-400 shrink-0" aria-hidden/>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm leading-snug">{t(`stretch.routines.${e.routine}.name`)}</span>
                      <span className="block text-xs text-slate-400">{day(e)} · {time(e)}</span>
                    </span>
                    <span className="text-xs text-slate-300 tabular-nums shrink-0">{t("stretch.sheet.minutes", { count: minutes(e.sec) })}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <p className="text-xs text-slate-500">{t("stretch.history.kept")}</p>
        </div>
      </div>
    </div>
  );
}
