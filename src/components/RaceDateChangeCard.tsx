import { CalendarClock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fmt } from "../utils/format";
import type { RaceDateChange } from "../utils/races";

type Props = {
  change: RaceDateChange;
  onApply: (c: RaceDateChange) => void;
  onKeep: (c: RaceDateChange) => void;
};

// A race on the user's list whose calendar date moved after they planned around it.
export function RaceDateChangeCard({ change, onApply, onKeep }: Props) {
  const { t } = useTranslation();
  return (
    <div role="status" className="rounded-xl p-3.5 border border-amber-500/35 bg-slate-800 space-y-3">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 rounded-xl bg-amber-500/15 flex items-center justify-center flex-shrink-0">
          <CalendarClock className="text-amber-400" size={18}/>
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">{t("races.dateChange.title")}</p>
          <p className="text-xs text-slate-400">
            {t("races.dateChange.body", { label: change.label, newDate: fmt.date(change.newDate), oldDate: fmt.date(change.oldDate) })}
          </p>
          {change.isTarget && <p className="text-xs text-slate-400 mt-1">{t("races.dateChange.planNote")}</p>}
        </div>
      </div>
      <div className="flex gap-2 pl-12">
        <button onClick={() => onApply(change)}
          className="bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors">
          {t(change.isTarget ? "races.dateChange.updatePlan" : "races.dateChange.useNewDate")}
        </button>
        <button onClick={() => onKeep(change)}
          className="bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-semibold px-4 py-2 rounded-lg transition-colors">
          {t("races.dateChange.keep")}
        </button>
      </div>
    </div>
  );
}

type ListProps = {
  changes?: RaceDateChange[];
  onApply?: (c: RaceDateChange) => void;
  onKeep?: (c: RaceDateChange) => void;
};

export function RaceDateChanges({ changes, onApply, onKeep }: ListProps) {
  if (!changes?.length || !onApply || !onKeep) return null;
  return <>{changes.map(c => <RaceDateChangeCard key={c.editionId} change={c} onApply={onApply} onKeep={onKeep}/>)}</>;
}
