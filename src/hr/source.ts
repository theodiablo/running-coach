import { isAndroid, isIos } from "../native";
import { bleSource } from "./ble";
import { healthConnectSource } from "./healthconnect";
import { healthKitSource } from "./healthkit";
import type { HrMethod } from "../types";

// Resolve the HR source for a method, or null for "off" / web / unknown (HR capture is native-only).
// Callers branch on `live`: true streams during the run (useRunTracker), false is fetched post-run.
// settings.hrMethod is a synced preference, so a platform-exclusive method must resolve to null off
// its platform, never reaching a bridge that doesn't exist.
export function getHrSource(method: HrMethod | string | null | undefined) {
  if (method === "bluetooth" && (isAndroid || isIos)) return bleSource;
  if (method === "healthconnect" && isAndroid) return healthConnectSource;
  if (method === "healthkit" && isIos) return healthKitSource;
  return null;
}
