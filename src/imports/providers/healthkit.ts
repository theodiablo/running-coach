import { isIos } from "../../native";
import {
  scanHealthKitWorkouts,
  hasHealthKitAuthorization,
  requestHealthKitPermissions,
} from "../../healthkit/import";
import type { ImportProvider } from "../types";
import type { Run } from "../../types";

// The one Apple Health integration, the iOS face of healthConnectProvider: every watch app writing to
// Apple Health surfaces through it (the run note names the app, hkImportedNote). Native source stays in
// src/healthkit/; both health-store providers share settings.watchImport (healthStoreProviderIds).
export const healthKitProvider: ImportProvider = {
  id: "healthkit",
  label: "Your watch (Apple Health)",
  kind: "healthkit",
  platform: "native",
  isAvailable: () => isIos, // HealthKit is iOS-only; Android gets the Health Connect provider
  isConnected: () => hasHealthKitAuthorization(),
  connect: () => requestHealthKitPermissions(),
  // No disconnect: the auth marker is SHARED with post-run HR, so clearing it would break a configured
  // hrMethod:"healthkit". "Turn off" flips watchImport, which gates scanning; revocation lives in the Health app.
  scan: (runs: Run[], opts?: { days?: number; now?: number }) =>
    scanHealthKitWorkouts(runs, {
      enabled: true, // the synced preference gate is applied by the caller (registry `enabled` predicate)
      allowNativeRead: hasHealthKitAuthorization(),
      ...(opts?.days ? { days: opts.days } : {}),
      ...(opts?.now ? { now: opts.now } : {}),
    }),
  help:
    "Works with the Apple Watch Workout app and any watch whose companion app writes " +
    "workouts to Apple Health (Garmin Connect, Polar Flow, Zepp…). Runs appear a few " +
    "minutes after your watch syncs. Apple Watch outdoor runs import the full route, " +
    "pace and heart-rate trace; most third-party watches import totals only.",
};
