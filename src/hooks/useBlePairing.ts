import { useState } from "react";
import { useTranslation } from "react-i18next";
import { bleSource, type BleDevice } from "../hr/ble";
import { setPairedDevice } from "../hr/device";
import { HR_BLE_DISCLOSED_KEY } from "../constants";
export type { BleDevice };

// Scan-and-pair mechanics for a Bluetooth heart-rate strap, shared by the
// Connections card and the onboarding heart-rate step so the prominent
// disclosure (a Play requirement) can never be skipped by the newer caller.
// Owns the persistence too: choosing a device IS pairing it (setPairedDevice),
// and the caller only decides what that means for its own state.
export function useBlePairing({ showToast, onPaired }: {
  showToast?: (msg: string, type?: string) => void;
  onPaired?: (device: BleDevice) => void;
}) {
  const { t } = useTranslation();
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<BleDevice[]>([]);
  const [showDisclosure, setShowDisclosure] = useState(false);

  const disclosed = () => {
    try { return localStorage.getItem(HR_BLE_DISCLOSED_KEY) === "1"; } catch { return false; }
  };
  const markDisclosed = () => {
    try { localStorage.setItem(HR_BLE_DISCLOSED_KEY, "1"); } catch { /* quota — non-fatal */ }
  };

  const runScan = async () => {
    setFound([]);
    setScanning(true);
    try {
      await bleSource.scan((d: BleDevice) =>
        setFound(prev => prev.some(x => x.id === d.id) ? prev : [...prev, d]));
    } catch {
      showToast?.(t("settings.hrSensor.scanFailed"), "err");
    }
    setScanning(false);
  };

  // Gate the first scan behind the prominent disclosure + OS Bluetooth prompt.
  const startScan = () => { if (disclosed()) void runScan(); else setShowDisclosure(true); };

  const acceptDisclosure = async () => {
    setShowDisclosure(false);
    const ok = await bleSource.requestPermissions();
    if (!ok) { showToast?.(t("settings.hrSensor.permissionNeeded"), "err"); return; }
    markDisclosed();
    void runScan();
  };
  const cancelDisclosure = () => setShowDisclosure(false);

  const choose = (d: BleDevice) => {
    setPairedDevice(d);
    setFound([]);
    onPaired?.(d);
  };

  return { scanning, found, startScan, choose, showDisclosure, acceptDisclosure, cancelDisclosure };
}
