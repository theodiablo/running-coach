import { useTranslation } from "react-i18next";
import { TCLR, runBarColor } from "../constants";
import { fmt } from "../utils/format";
import type { ReactNode, KeyboardEvent } from "react";
import type { Run, RunType } from "../types";

type RunRowProps = {
  run: Run;
  dateFmt?: (date: string) => string;
  showNotes?: boolean;
  actions?: ReactNode;
  // When set, the row's main content area becomes a button that opens the run's
  // detail view. Attached to the left content region only, so the `actions` slot
  // (map/edit/delete in History) keeps its own independent click targets.
  onClick?: () => void;
  // When set, the row gets an orange ring and shows `badgeLabel` as a small
  // pill — used to point out a run that just changed (async HR relink, watch
  // import) after navigating here from its toast.
  highlight?: boolean;
  badgeLabel?: string;
};

const typeClass = (type: Run["type"]) => TCLR[(type as RunType) || "OTHER"] || TCLR.OTHER;

// One run as a list row: colored type bar, distance + duration, a metrics
// sub-line (date · pace · HR · elevation), the type badge, and an optional
// right-side `actions` slot. Shared by the dashboard's recent-runs list and the
// full History view so the two never drift apart.
export function RunRow({run, dateFmt = fmt.sht, showNotes = false, actions = null, onClick, highlight = false, badgeLabel}: RunRowProps) {
  const { t } = useTranslation();
  const pace = run.km && run.durationSec ? run.durationSec / run.km : 0;
  const clickProps = onClick
    ? { role: "button", tabIndex: 0, onClick,
        onKeyDown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } }
    : {};
  // Whole row is the tap target when there's no `actions` slot (Dashboard), so the
  // type badge isn't dead space; with actions (History) only the content region is
  // clickable, leaving the map/edit/delete buttons as independent targets.
  const rowClick = onClick && !actions;
  const contentClick = onClick && !!actions;
  return (
    <div className={"bg-slate-800 rounded-xl p-3 flex items-center gap-3 transition-shadow" + (highlight ? " ring-2 ring-orange-400/70" : "") + (rowClick ? " cursor-pointer" : "")}
      {...(rowClick ? clickProps : {})}>
      <div className={"w-1.5 h-10 rounded-full flex-shrink-0 " + runBarColor(run.type || "OTHER")}/>
      <div className={"flex-1 min-w-0" + (contentClick ? " cursor-pointer" : "")} {...(contentClick ? clickProps : {})}>
        <p className="text-white text-sm font-medium flex items-center gap-1.5">
          <span className="truncate">{run.km ? run.km + " km · " + fmt.dur(run.durationSec) : fmt.dur(run.durationSec)}</span>
          {highlight && badgeLabel && (
            <span className="text-[10px] font-bold uppercase tracking-wide text-orange-300 bg-orange-500/20 px-1.5 py-0.5 rounded-full flex-shrink-0">{badgeLabel}</span>
          )}
        </p>
        <p className="text-slate-400 text-xs">
          {dateFmt(run.date)
            // No distance = no pace to quote (a cross-training session); a
            // "--:--/km" there claims a measurement that was never taken.
            + (run.km ? " · " + fmt.pace(pace) + "/km" : "")
            + (run.activity ? " · " + t("common.activities." + run.activity, {defaultValue: run.activity}) : "")
            + (run.hr ? " · ❤️ " + run.hr : "")
            + (run.elevation ? " · ⛰️ " + run.elevation + "m" : "")}
        </p>
        {showNotes && run.notes && <p className="text-slate-400 text-xs mt-0.5 truncate">{run.notes}</p>}
      </div>
      <span className={"text-xs font-semibold flex-shrink-0 " + typeClass(run.type)}>{t("common.types." + run.type, {defaultValue: run.type})}</span>
      {actions}
    </div>
  );
}
