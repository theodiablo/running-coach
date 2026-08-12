import { registerPlugin } from "@capacitor/core";
import { hexStringToDataView } from "@capacitor-community/bluetooth-le";
import { parseHrMeasurement } from "../utils/hr";
import { isAndroid } from "../native";
import type { BleHrSample } from "./ble";

// The native HR journal (Android, patched bluetooth-le plugin) — the HR twin of
// src/geo/fixJournal.ts. The GATT notification callback runs in the app process,
// so it keeps firing while the WebView's JS is frozen in the background; the
// plugin appends each measurement to a file, and the save path folds it back
// into what JS saw. Without it a run's HR is only ever what the foreground
// managed to observe.
//
// Armed for the duration of a run (never during the idle preview, whose samples
// aren't part of the run) and read once at save time. Arming is process state,
// so a run resumed after the app was killed has to re-arm — without clearing,
// since the beats from before the crash are exactly what the journal is for.
// Best-effort and Android-only throughout: every call no-ops elsewhere and never
// throws, and an unpatched shell simply resolves nothing — the JS stream stays
// the whole story.

const BluetoothLe = registerPlugin<{
  setHrJournal: (options: { enabled: boolean }) => Promise<void>;
  getHrJournal: () => Promise<{ entries?: unknown[] }>;
  clearHrJournal: () => Promise<void>;
}>("BluetoothLe");

// Clear any leftovers and start journalling — a fresh run starts empty.
export function resetHrJournal(): void {
  if (!isAndroid) return;
  BluetoothLe.clearHrJournal()
    .then(() => BluetoothLe.setHrJournal({ enabled: true }))
    .catch(() => { /* unpatched shell / best-effort */ });
}

// Journal from here on, keeping whatever is already there — a resumed run.
export function armHrJournal(): void {
  if (!isAndroid) return;
  BluetoothLe.setHrJournal({ enabled: true }).catch(() => { /* best-effort */ });
}

// Stop journalling but KEEP the contents — the save that follows still reads them.
export function disarmHrJournal(): void {
  if (!isAndroid) return;
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
