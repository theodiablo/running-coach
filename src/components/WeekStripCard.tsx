import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { dayName } from "../i18n";
import { fmt } from "../utils/format";
import { weekStrip, type WeekDayState } from "../utils/weekStrip";
import type { Plan, Run } from "../types";

const DOT: Record<WeekDayState, string> = {
  done: "bg-emerald-400 border-emerald-400",
  planned: "border-slate-500",
  open: "border-amber-400/70 bg-amber-400/15",
  rest: "border-slate-700 border-dashed",
};

// Home's "This week": a dot per day and one line of totals, in place of stat tiles.
export function WeekStripCard({ plan, runs, today, children }: { plan: Plan | null; runs: Run[]; today: Date; children?: ReactNode }) {
  const { t } = useTranslation();
  const w = weekStrip(plan, runs, today);
  const km = fmt.km(w.km) || "0";
  return (
    <div className="bg-slate-800 rounded-xl overflow-hidden">
      <div className="px-4 py-3 space-y-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm font-semibold">{t("dashboard.week.title")}</p>
          <p className="text-xs text-slate-400 tabular-nums">
            {w.sessions ? t("dashboard.week.plan", { done: w.done, count: w.sessions, km }) : t("dashboard.week.runs", { count: w.runs, km })}
          </p>
        </div>
        <div className="grid grid-cols-7 gap-1" aria-hidden>
          {w.days.map((d, i) => (
            <span key={d.date} className="flex flex-col items-center gap-1">
              <span className={"w-4 h-4 rounded-full border-[1.5px] " + DOT[d.state] + (d.today ? " ring-2 ring-orange-500/70 ring-offset-1 ring-offset-slate-800" : "")}/>
              <span className={"text-[10px] " + (d.today ? "text-orange-300 font-semibold" : "text-slate-500")}>{dayName(i)}</span>
            </span>
          ))}
        </div>
      </div>
      {children}
    </div>
  );
}
