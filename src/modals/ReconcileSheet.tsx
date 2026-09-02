// "I already ran this": pick which logged run settled a plan session.
//
// The app matches a run to a session on the calendar day alone, at the moment a
// recorder hands off to the log form. Do Thursday's tempo on Wednesday and the
// two never meet — the session stays untickable and the run stays anonymous.
// This sheet is the retroactive half of the fix: it ranks the runs that could
// plausibly be the session (src/utils/sessionMatch.ts) and lets the runner say
// which one it was. It only ever proposes — nothing is applied until "Count it".

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";
import { ConfirmButtons } from "../components/ModalPrimitives";
import { describeSession } from "../utils/sessionDesc";
import { fmt } from "../utils/format";
import { isCrossTraining } from "../types";
import type { Run } from "../types";
import type { SessionWithWeek } from "../utils/overdue";
import type { SavedRun } from "../utils/sessionMatch";

type ReconcileSheetProps = {
  session: SessionWithWeek;
  // Candidates, best first — the caller has already ranked and filtered them.
  runs: SavedRun[];
  // Whether re-dating the session to a given day keeps it inside its own plan
  // week. The sheet has no business knowing the plan's shape.
  canMoveTo: (date: string) => boolean;
  onConfirm: (runId: string, moveTo: string | null) => void;
  onClose: () => void;
};

export function ReconcileSheet({ session, runs, canMoveTo, onConfirm, onClose }: ReconcileSheetProps) {
  const { t } = useTranslation();
  useDismissable(true, onClose);

  const [picked, setPicked] = useState(runs[0]?.id || "");
  // The plan's dates feed the coach and the load rules, so a tempo left dated
  // Thursday that the legs did on Wednesday misstates recovery. Default on —
  // and only offered when the day is one the session's week can hold.
  const [move, setMove] = useState(true);

  const run = runs.find(r => r.id === picked) || null;
  const moves = !!run && run.date !== session.date && canMoveTo(run.date);

  const runLine = (r: Run) => {
    const parts = [fmt.dur(r.durationSec)];
    if (!isCrossTraining(r) && r.km && r.durationSec) parts.push(fmt.pace(r.durationSec / r.km) + "/km");
    if (r.hr) parts.push(r.hr + " bpm");
    return parts.join(" · ");
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-[2000] flex items-end animate-overlay-fade" onClick={onClose}>
      <div
        className="w-full bg-slate-800 border-t border-slate-700 rounded-t-2xl p-4 space-y-3 animate-slide-up max-h-[85vh] overflow-y-auto"
        style={{ paddingBottom: "calc(1.5rem + var(--safe-bottom))" }}
        onClick={e => e.stopPropagation()}
      >
        <div className="w-9 h-1 rounded-full bg-slate-600 mx-auto mb-1"/>
        <div>
          <h3 className="text-base font-bold text-white">{t("dashboard.reconcile.title")}</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            {describeSession(session) + " · " + t("dashboard.reconcile.scheduled", { date: fmt.sht(session.date) })}
          </p>
        </div>

        <div role="radiogroup" aria-label={t("dashboard.reconcile.title")} className="space-y-2">
          {runs.map((r, i) => {
            const on = r.id === picked;
            return (
              <button key={r.id} role="radio" aria-checked={on} onClick={() => setPicked(r.id)}
                className={"w-full flex items-start gap-3 px-3 py-2.5 rounded-xl border-2 text-left transition-colors "
                  + (on ? "border-orange-500 bg-orange-500/10" : "border-slate-700 bg-slate-900/40 hover:border-slate-600")}>
                <span className={"w-4 h-4 mt-0.5 rounded-full border-2 flex-shrink-0 flex items-center justify-center "
                  + (on ? "border-orange-500" : "border-slate-500")} aria-hidden>
                  {on && <span className="w-2 h-2 rounded-full bg-orange-500"/>}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm text-white font-medium">
                    {fmt.sht(r.date) + (isCrossTraining(r) ? "" : " · " + r.km + " km")}
                    {i === 0 && runs.length > 1 && (
                      <span className="ml-2 align-middle text-[10px] font-bold uppercase tracking-wide text-orange-300 border border-orange-500/40 rounded-full px-1.5 py-px">
                        {t("dashboard.reconcile.closest")}
                      </span>
                    )}
                  </span>
                  <span className="block text-[11px] text-slate-400 mt-0.5">{runLine(r)}</span>
                </span>
              </button>
            );
          })}
        </div>

        {moves && (
          <label className="flex items-center gap-3 pt-3 border-t border-slate-700 cursor-pointer">
            <input type="checkbox" checked={move} onChange={e => setMove(e.target.checked)}
              className="w-4 h-4 accent-orange-500 flex-shrink-0"/>
            <span className="text-xs text-slate-300 leading-snug">
              {t("dashboard.reconcile.move", { date: fmt.sht(run!.date) })}
            </span>
          </label>
        )}

        <ConfirmButtons
          onCancel={onClose}
          onAccept={() => { if (run) onConfirm(run.id, moves && move ? run.date : null); }}
          cancelLabel={t("common.cancel")}
          acceptLabel={t("dashboard.reconcile.confirm")}
        />
        <p className="flex items-center justify-center gap-1.5 text-[11px] text-slate-500 pt-0.5">
          <Check size={12}/>{t("dashboard.reconcile.note")}
        </p>
      </div>
    </div>
  );
}
