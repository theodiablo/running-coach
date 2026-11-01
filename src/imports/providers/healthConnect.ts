import { isAndroid } from "../../native";
import { scanWatchSessions, hasWatchAuthorization, setWatchAuthorization, WATCH_SCAN_DAYS } from "../../watch/import";
import { connectHealthConnect } from "../../health/connect";
import type { ImportProvider } from "../types";
import type { Run } from "../../types";

// The one Health Connect integration, brand-agnostic: every watch app that writes sessions
// to Health Connect surfaces through it, and the per-run note names the app (dataOrigin →
// importedNote). The native source stays in src/watch/; this is its ImportProvider face.
export const healthConnectProvider: ImportProvider = {
  id: "healthconnect",
  label: "Your watch (Health Connect)",
  kind: "healthconnect",
  platform: "native",
  isAvailable: () => isAndroid, // Health Connect is Android-only; iOS gets the HealthKit provider
  isConnected: () => hasWatchAuthorization(),
  // Ask for every Health Connect scope on one consent screen (the same grant also
  // authorizes the "Health Connect" heart-rate method). `activity` is true only
  // when the exercise/distance/elevation reads this import needs were granted.
  connect: async () => (await connectHealthConnect()).activity,
  disconnect: () => setWatchAuthorization(false),
  scan: (runs: Run[], opts?: { days?: number; now?: number; trigger?: string }) =>
    scanWatchSessions(runs, {
      enabled: true, // the synced preference gate is applied by the caller (registry `enabled` predicate)
      allowNativeRead: hasWatchAuthorization(),
      days: opts?.days ?? WATCH_SCAN_DAYS,
      ...(opts?.now ? { now: opts.now } : {}),
      ...(opts?.trigger ? { trigger: opts.trigger } : {}),
    }),
  help:
    "Works with any watch whose app writes workouts to Health Connect (Android 14+): " +
    "Garmin Connect (Settings → Health Connect) or Zepp/Amazfit (Profile → 3rd-party access → Health Connect). " +
    "Runs appear a few minutes after your watch syncs, with your heart-rate trace when the watch shares it. " +
    "No route/map is included (watch apps don't write GPS routes to Health Connect).",
};
