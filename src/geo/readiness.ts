import { isNative } from "../native";
import { geoSource } from "./source";
import { checkPreciseLocation } from "./native";
import { checkBackgroundLocation, requestBackgroundLocation } from "./background";
import { checkRunNotifications, requestRunNotifications } from "./notifications";
import { checkBatteryExempt, markBatteryNudgeDismissed, openBatteryOptimizationSettings } from "./battery";
import { markBgLocationDisclosed } from "./disclosure";
import { REC_NOTIF_ASKED_KEY } from "../constants";

// Race-day readiness: what a long screen-off recording needs, checked ahead of
// the start line rather than at it. Each check reuses the recorder's own
// helpers; a row the device doesn't have is simply absent.
export type ReadinessId = "location" | "background" | "notifications" | "battery";
export const READINESS_ORDER: ReadinessId[] = ["location", "background", "notifications", "battery"];
export type Readiness = Partial<Record<ReadinessId, boolean>>;

export const needsDisclosure = (id: ReadinessId) => id === "location" || id === "background";

export async function checkReadiness(): Promise<Readiness> {
  if (!isNative) return {};
  const [location, background, notifications, battery] = await Promise.all([
    // Precise, not just any grant: an approximate one still prompts at Start.
    checkPreciseLocation(),
    checkBackgroundLocation(),
    checkRunNotifications(),
    checkBatteryExempt(),
  ]);
  const out: Readiness = { location: !!location };
  if (background != null) out.background = background;
  if (notifications != null) out.notifications = notifications;
  if (battery != null) out.battery = battery;
  return out;
}

// Both location rows run only after the caller has shown the bg-location
// disclosure (`needsDisclosure`), so a grant here is a disclosed grant.
export async function fixReadiness(id: ReadinessId): Promise<void> {
  switch (id) {
    case "location":
      if (await geoSource.requestPermissions().catch(() => false)) markBgLocationDisclosed();
      return;
    case "background":
      markBgLocationDisclosed();
      await requestBackgroundLocation();
      return;
    case "notifications":
      try { localStorage.setItem(REC_NOTIF_ASKED_KEY, "1"); } catch { /* storage unavailable — still ask */ }
      await requestRunNotifications();
      return;
    case "battery":
      markBatteryNudgeDismissed();
      openBatteryOptimizationSettings();
      return;
  }
}
