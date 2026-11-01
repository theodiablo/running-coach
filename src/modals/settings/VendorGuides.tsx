import { useTranslation } from "react-i18next";
import { Upload } from "lucide-react";
import { isNative, isAndroid } from "../../native";
import { HowItWorks } from "../../views/ConnectionsCard";

// Vendors we can't connect to, explained rather than integrated: Strava's API bans AI use of its
// data (docs/health-integrations.md), Zepp has no indie cloud API, Garmin's is partner-gated.
// All three work via a file export/import (past runs) or the vendor app writing to the
// platform health store (new runs).
const VENDORS = ["strava", "zepp", "garmin"] as const;

export function VendorGuides({ onImportFile }: { onImportFile?: () => void }) {
  const { t } = useTranslation();
  // Which health store the "new runs" half should name. On web there is no
  // store to talk about — the mobile-app pointer above covers that.
  const syncKey = !isNative ? "syncWeb" : isAndroid ? "syncAndroid" : "syncIos";

  return (
    <div className="bg-slate-800 rounded-2xl p-4 space-y-3">
      <p className="text-sm font-semibold text-slate-200">{t("settings.guides.title")}</p>
      <p className="text-xs text-slate-400 -mt-1">{t("settings.guides.subtitle")}</p>

      {VENDORS.map(v => (
        <div key={v} className="pt-3 border-t border-slate-700/60">
          <HowItWorks label={t(`settings.guides.${v}.title`)}>
            <p className="text-slate-400 font-medium">{t("settings.guides.pastRuns")}</p>
            <p>{t(`settings.guides.${v}.history`)}</p>
            {onImportFile && (
              <button type="button" onClick={onImportFile}
                className="w-full mt-1 py-2 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center justify-center gap-2 transition-colors">
                <Upload size={15}/>{t("settings.guides.importCta")}
              </button>
            )}
            <p className="text-slate-400 font-medium pt-1">{t("settings.guides.newRuns")}</p>
            <p>{t(`settings.guides.${v}.${syncKey}`)}</p>
          </HowItWorks>
        </div>
      ))}

      <p className="text-xs text-slate-500 pt-1">{t("settings.guides.recordNote")}</p>
    </div>
  );
}
