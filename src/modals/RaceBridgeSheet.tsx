import { useTranslation } from "react-i18next";
import { Check, Trophy } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";

// Shown once, after the race a live-first runner onboarded for: the moment they
// might want a plan for the next one. Home keeps a quiet row for later.
export function RaceBridgeSheet({ label, onPlan, onClose }: { label: string; onPlan: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  useDismissable(true, onClose);
  return (
    <div className="fixed inset-0 bg-black/70 z-[2000] flex items-end animate-overlay-fade" onClick={onClose}>
      <div className="w-full max-h-full overflow-y-auto bg-slate-800 border-t border-slate-700 rounded-t-2xl p-5 space-y-4 text-center animate-slide-up"
        style={{ paddingBottom: "calc(1.5rem + var(--safe-bottom))" }}
        onClick={e => e.stopPropagation()}>
        <div className="w-12 h-12 rounded-full bg-emerald-500/15 flex items-center justify-center mx-auto animate-pop">
          <Check size={24} className="text-emerald-400"/>
        </div>
        <div>
          <p className="font-bold text-lg">{t("raceDay.bridge.title", { label })}</p>
          <p className="text-sm text-slate-400 mt-1">{t("raceDay.bridge.followers")}</p>
        </div>
        <div className="bg-slate-900/60 border border-orange-500/30 rounded-2xl p-4 space-y-3 text-left">
          <div className="flex items-start gap-2.5">
            <Trophy size={18} className="text-orange-400 shrink-0 mt-0.5"/>
            <div>
              <p className="text-sm font-semibold">{t("raceDay.bridge.nextTitle")}</p>
              <p className="text-xs text-slate-400 mt-0.5">{t("raceDay.bridge.nextBody")}</p>
            </div>
          </div>
          <button onClick={onPlan}
            className="w-full bg-orange-500 hover:bg-orange-600 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">
            {t("raceDay.bridge.cta")}
          </button>
        </div>
        <button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-200 transition-colors">
          {t("raceDay.bridge.notNow")}
        </button>
      </div>
    </div>
  );
}
