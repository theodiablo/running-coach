// The center FAB's chooser. Recording used to be a *destination* (the Log tab,
// which showed both recorders, the manual form and a file-import panel at once);
// the FAB now asks the one question that separates them — how did this run
// happen? — and each answer leads somewhere single-purpose.
//
// File import is deliberately absent: it is account admin, not a way to record
// today's run. It lives in Settings -> Integrations, with a quiet link from the
// manual form (the one place someone might realise they have a file).

import { useTranslation } from "react-i18next";
import { Bike, MapPin, PenLine } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";

type RecordSheetProps = {
  onTrack: () => void;
  onIndoor: () => void;
  onManual: () => void;
  onClose: () => void;
};

export function RecordSheet({ onTrack, onIndoor, onManual, onClose }: RecordSheetProps) {
  const { t } = useTranslation();
  // Registered here, in the overlay's own component, so Android back / Escape
  // close it via the LIFO dismiss registry.
  useDismissable(true, onClose);

  const pick = (run: () => void) => () => { onClose(); run(); };

  return (
    <div className="fixed inset-0 bg-black/70 z-[2000] flex items-end animate-overlay-fade" onClick={onClose}>
      <div
        className="w-full bg-slate-800 border-t border-slate-700 rounded-t-2xl p-4 space-y-2.5 animate-slide-up"
        style={{ paddingBottom: "calc(1.5rem + var(--safe-bottom))" }}
        onClick={e => e.stopPropagation()}
      >
        <div className="w-9 h-1 rounded-full bg-slate-600 mx-auto mb-1"/>
        <h3 className="text-base font-bold text-white">{t("log.sheet.title")}</h3>

        <button onClick={pick(onTrack)}
          className="w-full flex items-center gap-3 bg-orange-500 hover:bg-orange-600 text-white px-4 py-3 rounded-xl text-left transition-colors">
          <MapPin size={18} className="flex-shrink-0"/>
          <span>
            <span className="block text-sm font-semibold">{t("log.sheet.track")}</span>
            <span className="block text-xs text-orange-50/80">{t("log.sheet.trackSub")}</span>
          </span>
        </button>

        <button onClick={pick(onIndoor)}
          className="w-full flex items-center gap-3 bg-slate-700/60 hover:bg-slate-700 border border-slate-600 text-slate-100 px-4 py-3 rounded-xl text-left transition-colors">
          <Bike size={18} className="text-violet-400 flex-shrink-0"/>
          <span>
            <span className="block text-sm font-semibold">{t("log.sheet.indoor")}</span>
            <span className="block text-xs text-slate-400">{t("log.sheet.indoorSub")}</span>
          </span>
        </button>

        <button onClick={pick(onManual)}
          className="w-full flex items-center gap-3 bg-slate-700/60 hover:bg-slate-700 border border-slate-600 text-slate-100 px-4 py-3 rounded-xl text-left transition-colors">
          <PenLine size={18} className="text-slate-300 flex-shrink-0"/>
          <span>
            <span className="block text-sm font-semibold">{t("log.sheet.manual")}</span>
            <span className="block text-xs text-slate-400">{t("log.sheet.manualSub")}</span>
          </span>
        </button>
      </div>
    </div>
  );
}
