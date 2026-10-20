import { useState } from "react";
import { useTranslation } from "react-i18next";
import { INPUT_CLS } from "../constants";
import { HRZoneBar } from "../components/HRZoneBar";
import { HrZonesInfo } from "../components/HrZonesInfo";
import { deriveAge, runnerAge, tanakaMaxHR } from "../utils/hr";
import type { SettingsState } from "../types";

type HRZonesProps = {
  settings: SettingsState;
  saveSettings: (settings: SettingsState) => void;
};

// Editable heart-rate profile, nested inside the Settings → Profile card (no
// outer card of its own). Auto-saves on blur; the full zone breakdown lives in
// Progress → Stats (HRZonesCard).
export function HRZones({settings, saveSettings}: HRZonesProps) {
  const { t } = useTranslation();
  const thisYear = new Date().getFullYear();
  // Legacy-age blobs (no birthYear yet) seed a derived birth year so blurring
  // any field lazily migrates them; ±1 yr imprecision is fine for Tanaka.
  const legacyAge = runnerAge(settings);
  const [birthYear, setBirthYear] = useState(
    String(settings.birthYear || (legacyAge != null ? thisYear - legacyAge : "") || ""));
  const [maxHR,  setMaxHR]  = useState(String(settings.maxHR || ""));
  const [restHR, setRestHR] = useState(String(settings.restHR || 60));
  const [maxHRHint, setMaxHRHint] = useState("");

  const byN   = parseInt(birthYear) || 0;
  const ageN  = deriveAge(byN);
  const mhrN  = parseInt(maxHR)  || 0;
  const rhrN  = parseInt(restHR) || 60;
  const tanakaMax = ageN != null ? tanakaMaxHR(ageN) : null;
  const effMax = mhrN || tanakaMax || 0;
  const ready  = effMax > 0 && rhrN > 0 && effMax - rhrN > 0;

  // Settings fields auto-save on blur (no Save button) — commit reads the
  // coalesced numbers; estimateHR persists explicitly since setState is async.
  // The derived age is written alongside birthYear so old app versions (which
  // read/write only `age`) stay consistent.
  const commit = () => {
    saveSettings({...settings, birthYear:byN, age:ageN ?? 0, maxHR:mhrN||tanakaMax||0, restHR:rhrN});
  };

  const estimateHR = () => {
    if (!tanakaMax) { setMaxHRHint(t("settings.hr.enterBirthYear")); return; }
    setMaxHR(String(tanakaMax));
    setRestHR("60");
    setMaxHRHint(t("settings.hr.estimated", { max: tanakaMax }));
    saveSettings({...settings, birthYear:byN, age:ageN ?? 0, maxHR:tanakaMax, restHR:60});
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 pt-1">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{t("settings.hr.title")}</p>
        <HrZonesInfo settings={settings}/>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div><label className="text-xs text-slate-400 block mb-1.5">{t("settings.hr.birthYear")}</label>
          <input type="number" min={thisYear - 90} max={thisYear - 10} placeholder="1990" value={birthYear} onChange={e => setBirthYear(e.target.value)} onBlur={commit} className={INPUT_CLS}/></div>
        <div><label className="text-xs text-slate-400 block mb-1.5">{t("settings.hr.maxHr")}</label>
          <input type="number" min="100" max="230" placeholder={t("settings.hr.autoPlaceholder")} value={maxHR} onChange={e => setMaxHR(e.target.value)} onBlur={commit} className={INPUT_CLS}/></div>
        <div><label className="text-xs text-slate-400 block mb-1.5">{t("settings.hr.restHr")}</label>
          <input type="number" min="30" max="120" placeholder="60" value={restHR} onChange={e => setRestHR(e.target.value)} onBlur={commit} className={INPUT_CLS}/></div>
      </div>

      <div>
        {!mhrN && (
          <button type="button" onClick={estimateHR}
            className="text-xs text-sky-300 hover:text-sky-200 underline underline-offset-2 transition-colors">
            {t("settings.hr.dontKnow")}
          </button>
        )}
        {maxHRHint && <p className="text-xs text-slate-500 mt-1.5">{maxHRHint}</p>}
      </div>

      {ready && (
        <div className="space-y-1.5">
          <HRZoneBar effMax={effMax} restHR={rhrN}/>
          <p className="text-xs text-slate-500">{t("settings.hr.fullBreakdown")}</p>
        </div>
      )}
    </div>
  );
}
