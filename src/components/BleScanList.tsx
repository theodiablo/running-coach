import { useTranslation } from "react-i18next";
import { Bluetooth, Loader, Check } from "lucide-react";
import { HrSensorDisclosure } from "../modals/HrSensorDisclosure";
import type { useBlePairing } from "../hooks/useBlePairing";

// The scan button + result list, shared with the onboarding heart-rate step so
// both places pair a strap through the same disclosure-gated flow.
export function BleScanList({ pairing, pairedId }: { pairing: ReturnType<typeof useBlePairing>; pairedId?: string }) {
  const { t } = useTranslation();
  const { scanning, found, startScan, choose, showDisclosure, acceptDisclosure, cancelDisclosure } = pairing;
  return (
    <div className="space-y-2">
      <button type="button" onClick={startScan} disabled={scanning}
        className="w-full py-2.5 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center justify-center gap-2 disabled:opacity-50">
        {scanning ? <Loader size={15} className="animate-spin" /> : <Bluetooth size={15} />}
        {scanning ? t("settings.hrSensor.scanning") : t("settings.hrSensor.pair")}
      </button>
      {found.map(d => (
        <button key={d.id} type="button" onClick={() => choose(d)}
          className="w-full flex items-center justify-between gap-2 bg-slate-700/60 hover:bg-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200">
          <span className="truncate">{d.name}</span>
          {pairedId === d.id && <Check size={15} className="text-emerald-400 shrink-0" />}
        </button>
      ))}
      {!scanning && !found.length && (
        <p className="text-xs text-slate-500">{t("settings.hrSensor.pairHelp")}</p>
      )}
      {showDisclosure && <HrSensorDisclosure onAccept={acceptDisclosure} onCancel={cancelDisclosure} />}
    </div>
  );
}
