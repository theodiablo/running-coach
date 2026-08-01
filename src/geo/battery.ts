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
