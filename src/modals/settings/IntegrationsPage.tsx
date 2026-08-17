import { useTranslation } from "react-i18next";
import { Upload } from "lucide-react";
import { ConnectionsCard } from "../../views/ConnectionsCard";
import { VendorGuides } from "./VendorGuides";
import type { SettingsState } from "../../types";

// Integrations: everything that feeds runs or heart rate in from outside.
// ConnectionsCard holds the sources we can actually connect to; VendorGuides
// covers the ones we can only explain (Strava, Zepp) — see its header.
//
// This page is the home of file import: it is account admin, not a way to
// record today's run, so the recording flow (the FAB's RecordSheet) doesn't
// mention it. The card below is the entry point — the per-vendor buttons inside
// the guides sit behind a collapsed accordion, which made import feel missing
// unless you guessed which vendor to expand.
type IntegrationsPageProps = {
  settings: SettingsState;
  saveSettings: (settings: SettingsState) => void;
  showToast?: (msg: string, type?: string) => void;
  scanImportsNow?: () => Promise<number>;
  onImportFile?: () => void;
};

export function IntegrationsPage({ onImportFile, ...connectionProps }: IntegrationsPageProps) {
  const { t } = useTranslation();
  return (
    <>
      <ConnectionsCard {...connectionProps}/>
      {onImportFile && (
        <div className="bg-slate-800 rounded-2xl p-4 space-y-2">
          <p className="text-sm font-semibold text-slate-200">{t("settings.importFile.title")}</p>
          <p className="text-xs text-slate-400">{t("settings.importFile.subtitle")}</p>
          <button type="button" onClick={onImportFile}
            className="w-full py-2.5 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center justify-center gap-2 transition-colors">
            <Upload size={15}/>{t("settings.importFile.cta")}
          </button>
        </div>
      )}
      <VendorGuides onImportFile={onImportFile}/>
    </>
  );
}
