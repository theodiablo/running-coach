import { registerPlugin } from "@capacitor/core";
import { hexStringToDataView } from "@capacitor-community/bluetooth-le";
import { parseHrMeasurement } from "../utils/hr";
import { isAndroid } from "../native";
import { logTrack } from "../geo/trackLog";
import type { BleHrSample } from "./ble";

// Native HR journal (Android, patched bluetooth-le), twin of src/geo/fixJournal.ts: the GATT callback
// keeps appending beats to a file while JS is frozen; save folds it back in. Armed during a run only
// (not the idle preview); re-arm WITHOUT clearing after a kill. Android-only, best-effort, never throws.

// Its own bridge proxy, NOT the BleClient wrapper: BleClient serializes every
// call through one queue, and reading the journal must never wait on the radio.
const BluetoothLe = registerPlugin<{
  setHrJournal: (options: { enabled: boolean }) => Promise<void>;
  getHrJournal: () => Promise<{ entries?: unknown[] }>;
  clearHrJournal: () => Promise<void>;
  getHrLastBeat: () => Promise<{ t?: number }>;
}>("BluetoothLe");

// Clear any leftovers and start journalling — a fresh run starts empty.
export function resetHrJournal(): void {
  if (!isAndroid) return;
  logTrack("hr-journal", { msg: "reset+arm" });
  BluetoothLe.clearHrJournal()
    .then(() => BluetoothLe.setHrJournal({ enabled: true }))
    .catch(() => { /* unpatched shell / best-effort */ });
}

// Journal from here on, keeping whatever is already there — a resumed run.
export function armHrJournal(): void {
  if (!isAndroid) return;
  logTrack("hr-journal", { msg: "arm" });
  BluetoothLe.setHrJournal({ enabled: true }).catch(() => { /* best-effort */ });
}

// Stop journalling but KEEP the contents — the save that follows still reads them.
export function disarmHrJournal(): void {
  if (!isAndroid) return;
  logTrack("hr-journal", { msg: "disarm" });
  BluetoothLe.setHrJournal({ enabled: false }).catch(() => { /* best-effort */ });
}

export function clearHrJournal(): void {
  if (!isAndroid) return;
  BluetoothLe.clearHrJournal().catch(() => { /* best-effort */ });
}

// Journalled measurements as { bpm, t }. Entries are the raw characteristic
// payload, parsed here by the same tested parser the live stream uses, so a
// malformed line costs one sample rather than the journal.
export async function readHrJournal(): Promise<BleHrSample[]> {
  if (!isAndroid) return [];
  try {
    const res = await BluetoothLe.getHrJournal();
    const out: BleHrSample[] = [];
    for (const e of res?.entries || []) {
      const entry = e as { v?: unknown; t?: unknown };
      if (typeof entry?.v !== "string" || typeof entry?.t !== "number") continue;
      try {
        const parsed = parseHrMeasurement(hexStringToDataView(entry.v));
        if (parsed) out.push({ bpm: parsed.bpm, t: entry.t });
      } catch { /* torn or malformed line — skip it */ }
    }
    return out.sort((a, b) => a.t - b.t);
  } catch { return []; }
}

// Epoch ms of the last measurement the GATT callback saw, or null when unavailable (off Android,
// unpatched shell, no beat yet). The callback keeps firing whether or not the WebView is awake,
// so it, not the JS stream, says whether the link is alive; `ble.ts` asks before tearing it down.
export async function lastNativeHrBeatAt(): Promise<number | null> {
  if (!isAndroid) return null;
  try {
    const res = await BluetoothLe.getHrLastBeat();
    return typeof res?.t === "number" && res.t > 0 ? res.t : null;
  } catch { return null; }
}
