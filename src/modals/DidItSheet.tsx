// "I did it" on a plan session: one door for every way a done session gets recorded, so the
// session card carries two verbs (Start run, I did it) instead of five.

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Link2, PenLine } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";
import { track } from "../telemetry";
import { describeSession } from "../utils/sessionDesc";
import { fmt } from "../utils/format";
import type { PlanSession } from "../types";

export type DidItChoice = "details" | "saved" | "tick";

type DidItSheetProps = {
  session: PlanSession;
  /** A future session can't be ticked off yet (it would consume sessions weeks out); the note on
   *  when it can is left out when a saved run can settle it now. */
  canTick: boolean;
  /** Runs already in the log that could be this session; absent hides the row. */
  hasSavedRuns: boolean;
  onPick: (choice: DidItChoice) => void;
  onClose: () => void;
};

export function DidItSheet({ session, canTick, hasSavedRuns, onPick, onClose }: DidItSheetProps) {
  const { t } = useTranslation();
  useDismissable(true, onClose);

  const pick = (choice: DidItChoice) => () => { track("did_it_picked", { choice }); onClose(); onPick(choice); };
  const row = (choice: DidItChoice, icon: ReactNode, title: string, sub: string, primary = false) => (
    <button onClick={pick(choice)}
      className={"w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-colors " + (primary
        ? "bg-orange-500 hover:bg-orange-600 text-white"
        : "bg-slate-700/60 hover:bg-slate-700 border border-slate-600 text-slate-100")}>
      <span className="w-5 flex justify-center flex-shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className={"block text-xs " + (primary ? "text-orange-50/80" : "text-slate-400")}>{sub}</span>
      </span>
    </button>
  );

  return (
    <div className="fixed inset-0 bg-black/70 z-[2000] flex items-end animate-overlay-fade" onClick={onClose}>
      <div role="dialog" aria-label={t("log.didIt.title")}
        className="w-full max-h-full overflow-y-auto bg-slate-800 border-t border-slate-700 rounded-t-2xl p-4 space-y-2.5 animate-slide-up"
        style={{ paddingBottom: "calc(1.5rem + var(--safe-bottom))" }}
        onClick={e => e.stopPropagation()}>
        <div className="w-9 h-1 rounded-full bg-slate-600 mx-auto mb-1"/>
        <div>
          <h3 className="text-base font-bold text-white">{t("log.didIt.title")}</h3>
          <p className="text-xs text-slate-400 mt-0.5 truncate">{describeSession(session)}</p>
        </div>
        {row("details", <PenLine size={18}/>, t("log.didIt.details"), t("log.didIt.detailsSub"), true)}
        {hasSavedRuns && row("saved", <Link2 size={18} className="text-orange-300"/>, t("log.didIt.saved"), t("log.didIt.savedSub"))}
        {canTick
          ? row("tick", <Check size={18} className="text-emerald-400"/>, t("log.didIt.tick"), t("log.didIt.tickSub"))
          : !hasSavedRuns && <p className="text-xs text-slate-500 text-center leading-snug px-2 pt-1">{t("log.didIt.tickLocked", { date: fmt.sht(session.date) })}</p>}
      </div>
    </div>
  );
}
