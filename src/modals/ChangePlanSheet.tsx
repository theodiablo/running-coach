// "Change my plan": asks what the runner wants to change, and each answer opens one single-purpose
// place (RecordSheet's pattern). Every door that changes the plan leads here.

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight, CalendarDays, Flag, Gauge } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";
import { CoachAvatar } from "../components/CoachAvatar";

export type ChangePlanChoice = "goal" | "avail" | "style" | "session" | "coach";

type ChangePlanSheetProps = {
  /** A plan with no race: the goal row reads "What I'm training for". */
  openPlan?: boolean;
  onPick: (choice: ChangePlanChoice) => void;
  onClose: () => void;
};

export function ChangePlanSheet({ openPlan = false, onPick, onClose }: ChangePlanSheetProps) {
  const { t } = useTranslation();
  useDismissable(true, onClose);

  const pick = (choice: ChangePlanChoice) => () => { onClose(); onPick(choice); };
  const row = (choice: ChangePlanChoice, icon: ReactNode, title: string, sub: string) => (
    <button key={choice} onClick={pick(choice)}
      className="w-full flex items-center gap-3 bg-slate-700/60 hover:bg-slate-700 border border-slate-600 text-slate-100 px-4 py-3 rounded-xl text-left transition-colors">
      <span className="w-5 flex justify-center flex-shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs text-slate-400">{sub}</span>
      </span>
    </button>
  );

  return (
    <div className="fixed inset-0 bg-black/70 z-[2000] flex items-end animate-overlay-fade" onClick={onClose}>
      <div role="dialog" aria-label={t("plan.change.title")}
        className="w-full max-h-full overflow-y-auto bg-slate-800 border-t border-slate-700 rounded-t-2xl p-4 space-y-2.5 animate-slide-up"
        style={{ paddingBottom: "calc(1.5rem + var(--safe-bottom))" }}
        onClick={e => e.stopPropagation()}>
        <div className="w-9 h-1 rounded-full bg-slate-600 mx-auto mb-1"/>
        <h3 className="text-base font-bold text-white">{t("plan.change.title")}</h3>
        {row("goal", <Flag size={18} className="text-orange-400"/>,
          t(openPlan ? "plan.change.goalOpen" : "plan.change.goal"), t(openPlan ? "plan.change.goalOpenSub" : "plan.change.goalSub"))}
        {row("avail", <CalendarDays size={18} className="text-sky-400"/>, t("plan.change.avail"), t("plan.change.availSub"))}
        {row("style", <Gauge size={18} className="text-emerald-400"/>, t("plan.change.style"), t("plan.change.styleSub"))}
        {row("session", <ArrowLeftRight size={18} className="text-slate-300"/>, t("plan.change.session"), t("plan.change.sessionSub"))}
        {row("coach", <CoachAvatar chip size={15}/>, t("plan.change.coach"), t("plan.change.coachSub"))}
        <p className="text-xs text-slate-500 text-center pt-1">{t("plan.change.note")}</p>
      </div>
    </div>
  );
}
