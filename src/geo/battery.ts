import { registerPlugin } from "@capacitor/core";
import { isAndroid } from "../native";
import { BATTERY_NUDGE_KEY } from "../constants";

// Android battery-optimization guidance. An "optimized" app can be killed by
// the OS while recording in the background — the #1 cause of a lost run — so
// the tracker offers the exemption screen once per install. Deliberately the
// SETTINGS LIST screen (ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS), not the
// direct request dialog: the direct dialog needs the
// REQUEST_IGNORE_BATTERY_OPTIMIZATIONS manifest permission, which Google Play
// restricts — the list screen needs nothing and can't fail review. Backed by
// the local RunPermissions plugin; Android-only, never throws, and a dismissal
// (or the check failing) never blocks recording.

type RunPermissionsBattery = {
  checkBatteryOptimization: () => Promise<{ ignoringOptimizations?: boolean }>;
  openBatteryOptimizationSettings: () => Promise<void>;
  checkPowerSaveMode: () => Promise<{ powerSaveMode?: boolean }>;
};

let cached: RunPermissionsBattery | null = null;
function plugin(): RunPermissionsBattery {
  if (!cached) cached = registerPlugin<RunPermissionsBattery>("RunPermissions");
  return cached;
}

// Whether to show the one-time nudge: Android, not yet shown, and the app is
// currently subject to battery optimization. Any failure reads as "don't nag".
export async function shouldNudgeBatteryOptimization(): Promise<boolean> {
  if (!isAndroid) return false;
  try { if (localStorage.getItem(BATTERY_NUDGE_KEY) === "1") return false; } catch { return false; }
  try {
    const res = await plugin().checkBatteryOptimization();
    return res?.ignoringOptimizations === false;
  } catch { return false; }
}

export function markBatteryNudgeDismissed(): void {
  try { localStorage.setItem(BATTERY_NUDGE_KEY, "1"); } catch { /* non-fatal */ }
}

export function openBatteryOptimizationSettings(): void {
  plugin().openBatteryOptimizationSettings().catch(() => { /* best-effort */ });
}

// The power regime as one log line, or null when there is nothing to say (web,
// iOS, or the bridge failing). Both halves matter and they are different
// settings: Battery Saver is device-wide and flips itself at a low-battery
// threshold, while the optimization exemption is per-app and sticky.
export async function powerStateSummary(): Promise<string | null> {
  if (!isAndroid) return null;
  try {
    const [saver, battery] = await Promise.all([
      plugin().checkPowerSaveMode(),
      plugin().checkBatteryOptimization(),
    ]);
    return `saver=${saver?.powerSaveMode === true} unrestricted=${battery?.ignoringOptimizations === true}`;
  } catch { return null; }
}
