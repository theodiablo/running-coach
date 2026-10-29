// "Sore or injured?" during the recovery after a race: lighten what's left, or
// hand it to the coach. Never a block on anything (docs/training-plan.md).

import { useTranslation } from "react-i18next";
import { HeartPulse } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";
import { CoachAvatar } from "../components/CoachAvatar";

type RecoverySoreSheetProps = {
  onLighter: () => void;
  onCoach: () => void;
  onClose: () => void;
};

export function RecoverySoreSheet({ onLighter, onCoach, onClose }: RecoverySoreSheetProps) {
  const { t } = useTranslation();
  useDismissable(true, onClose);

  return (
    <div className="fixed inset-0 bg-black/70 z-[2000] flex items-end animate-overlay-fade" onClick={onClose}>
      <div
        className="w-full max-w-lg mx-auto bg-slate-800 border-t border-slate-700 rounded-t-2xl p-4 space-y-3 animate-slide-up"
        style={{ paddingBottom: "calc(1.5rem + var(--safe-bottom))" }}
        onClick={e => e.stopPropagation()}
      >
        <div className="w-9 h-1 rounded-full bg-slate-600 mx-auto mb-1"/>
        <div>
          <h3 className="text-base font-bold text-white">{t("dashboard.sore.title")}</h3>
          <p className="text-xs text-slate-400 mt-0.5 leading-snug">{t("dashboard.sore.body")}</p>
        </div>
        <button onClick={onLighter}
          className="w-full text-left rounded-xl bg-orange-500 hover:bg-orange-600 text-white px-4 py-3 transition-colors">
          <span className="block text-sm font-semibold">{t("dashboard.sore.lighter")}</span>
          <span className="block text-xs text-orange-100/90 mt-0.5">{t("dashboard.sore.lighterHint")}</span>
        </button>
        <button onClick={onCoach}
          className="w-full flex items-center justify-center gap-1.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-100 py-3 text-sm font-semibold transition-colors">
          <CoachAvatar chip size={15}/>{t("dashboard.sore.coach")}
        </button>
        <p className="flex items-start gap-1.5 text-[11px] text-slate-400 leading-snug">
          <HeartPulse size={13} className="flex-shrink-0 mt-px"/>{t("dashboard.sore.caveat")}
        </p>
      </div>
    </div>
  );
}
