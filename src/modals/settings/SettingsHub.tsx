import { useTranslation } from "react-i18next";
import { User, Cable, HeartPulse, ChevronRight } from "lucide-react";

// The settings root: a menu, nothing else. Every actual control lives on one of
// the three sub-pages, so this screen stays scannable as integrations pile up.
export type SettingsPage = "account" | "integrations" | "training";

const ROWS: { page: SettingsPage; Icon: typeof User }[] = [
  { page: "account", Icon: User },
  { page: "integrations", Icon: Cable },
  { page: "training", Icon: HeartPulse },
];

export function SettingsHub({ onOpen }: { onOpen: (page: SettingsPage) => void }) {
  const { t } = useTranslation();
  return (
    <div className="bg-slate-800 rounded-2xl divide-y divide-slate-700/60 overflow-hidden">
      {ROWS.map(({ page, Icon }) => (
        <button key={page} type="button" onClick={() => onOpen(page)}
          className="w-full flex items-center gap-3 p-4 text-left hover:bg-slate-700/40 transition-colors">
          <Icon size={18} className="text-orange-400 shrink-0"/>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-slate-200">{t(`settings.hub.${page}.title`)}</span>
            <span className="block text-xs text-slate-400 mt-0.5">{t(`settings.hub.${page}.desc`)}</span>
          </span>
          <ChevronRight size={16} className="text-slate-500 shrink-0"/>
        </button>
      ))}
    </div>
  );
}
