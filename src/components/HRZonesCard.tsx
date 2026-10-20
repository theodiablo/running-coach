import { useTranslation } from "react-i18next";
import { fmt } from "../utils/format";
import { HR_ZONES, effectiveMaxHR, hrZoneBpm, runZoneIndex } from "../utils/hr";
import { HRZoneBar } from "./HRZoneBar";
import { HrZonesInfo } from "./HrZonesInfo";
import type { Run, SettingsState } from "../types";

type HRZonesCardProps = { runs: Run[]; settings: SettingsState };

// Heart-rate zones reference + recent-run zone breakdown, shown in Progress →
// Stats. Reads the persisted HR profile from settings (configured in Settings →
// Profile); renders nothing until a usable profile exists.
export function HRZonesCard({runs, settings}: HRZonesCardProps) {
  const { t } = useTranslation();
  const effMax = effectiveMaxHR(settings);
  const restHR = settings.restHR || 60;
  if (!(effMax > 0 && effMax - restHR > 0)) return null;

  const hrRuns = runs.filter(r => r.hr).slice(0, 6);

  return (
    <div className="p-4 space-y-5">
      <div className="bg-slate-800 rounded-2xl p-4">
        <div className="flex items-center justify-between gap-2 mb-4">
          <p className="text-sm font-semibold text-slate-200">{t("progress.zones.title")}</p>
          <HrZonesInfo settings={settings}/>
        </div>
        <div className="mb-4"><HRZoneBar effMax={effMax} restHR={restHR}/></div>
        <div className="space-y-1">
          {HR_ZONES.map(z => {
            const r = hrZoneBpm(z.lo, z.hi, effMax, restHR);
            const aeroClass = z.type === "Aerobic"
              ? "bg-emerald-500/15 text-emerald-400"
              : "bg-orange-500/15 text-orange-400";
            return (
              <div key={z.n} className="flex items-center gap-3 py-2.5 border-b border-slate-700/50 last:border-0">
                <div className="w-3 h-3 rounded-full flex-shrink-0" style={{background:z.clr}}/>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-white">{t("progress.zones.zoneLabel", {n: z.n, name: t("progress.zones.names." + z.n)})}</span>
                    <span className={"text-xs px-1.5 py-0.5 rounded-full " + aeroClass}>{t("progress.zones.types." + z.type)}</span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5 leading-snug">{t("progress.zones.descs." + z.n)}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-bold text-white">{r ? (r.lo + "–" + r.hi) : "-"}</p>
                  <p className="text-xs text-slate-500">{Math.round(z.lo*100) + "–" + Math.round(z.hi*100) + "%"}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {hrRuns.length > 0 && (
        <div className="bg-slate-800 rounded-2xl p-4">
          <p className="text-sm font-semibold text-slate-200 mb-3">{t("progress.zones.recentTitle")}</p>
          <div className="space-y-1">
            {hrRuns.map(r => {
              const zIdx  = runZoneIndex(r.hr, effMax, restHR);
              const zData = zIdx ? HR_ZONES[zIdx - 1] : null;
              return (
                <div key={r.id} className="flex items-center gap-3 py-2 border-b border-slate-700/30 last:border-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white">{t("progress.zones.runLine", {date: fmt.sht(r.date), km: r.km})}</p>
                    <p className="text-xs text-slate-500">
                      {t("progress.zones.avgHrLabel")}<span className="text-red-400">{t("progress.zones.bpmValue", {bpm: r.hr})}</span>
                    </p>
                  </div>
                  {zData ? (
                    <div className="text-right flex-shrink-0">
                      <span className="text-xs font-semibold px-2 py-1 rounded-lg"
                        style={{background: zData.clr + "25", color: zData.clr}}>
                        {t("progress.zones.zoneLabel", {n: zData.n, name: t("progress.zones.names." + zData.n)})}
                      </span>
                      <p className={"text-xs mt-0.5 " + (zData.type === "Aerobic" ? "text-emerald-400" : "text-orange-400")}>
                        {t("progress.zones.types." + zData.type)}
                      </p>
                    </div>
                  ) : (
                    <span className="text-xs text-slate-600">–</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
