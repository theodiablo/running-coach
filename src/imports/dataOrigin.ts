// Map a Health Connect record's dataOrigin (the writing app's Android package)
// to a friendly brand label for run notes ("Imported from Zepp"). Names are used
// nominatively only — no logos or endorsement wording. Unknown packages fall
// back to a generic label so new brands work without a code change.
const ORIGIN_LABELS: Record<string, string> = {
  "com.garmin.android.apps.connectmobile": "Garmin",
  "com.huami.watch.hmwatchmanager": "Zepp",           // Amazfit's companion app
  "com.zepp.zepposapp": "Zepp",
  "com.xiaomi.wearable": "Mi Fitness",
  "com.mc.miband1": "Notify",                          // Notify for Amazfit/Mi Band
  "com.fitbit.FitbitMobile": "Fitbit",
  "com.sec.android.app.shealth": "Samsung Health",
  "com.google.android.apps.fitness": "Google Fit",
  "com.polar.polarflow": "Polar",
  "com.suunto.movescount.android": "Suunto",
  "com.coros.coros": "COROS",
  "com.google.android.apps.healthdata": "Health Connect",
};

export function dataOriginLabel(pkg?: string | null): string {
  if (!pkg) return "your watch";
  return ORIGIN_LABELS[pkg] || "your watch";
}

// The note stamped on an imported run, e.g. "Imported from Garmin".
export function importedNote(pkg?: string | null): string {
  return "Imported from " + dataOriginLabel(pkg);
}

// iOS bundle-id equivalents for HealthKit workouts (src/healthkit/). A watch-recorded
// workout carries a per-device "com.apple.health.<hash>" id, hence the prefix match;
// unknown apps fall back to HealthKit's display name, so new brands need no code change.
const HK_ORIGIN_LABELS: Record<string, string> = {
  "com.garmin.connect.mobile": "Garmin",
  "com.zepp.ios.zepposapp": "Zepp",
  "com.huami.midong": "Zepp",                 // Amazfit's older companion app
  "com.fitbit.FitbitMobile": "Fitbit",
  "com.polar.polarflow": "Polar",
  "com.suunto.SuuntoApp": "Suunto",
  "com.coros.trainingpeaks": "COROS",
  "com.strava.stravaride": "Strava",          // manual app exports synced to Health
  "com.apple.health": "Apple Health",
};

export function hkOriginLabel(bundleId?: string | null, sourceName?: string | null): string {
  if (bundleId) {
    if (HK_ORIGIN_LABELS[bundleId]) return HK_ORIGIN_LABELS[bundleId];
    if (bundleId.startsWith("com.apple.health")) return "Apple Watch";
  }
  return sourceName || "your watch";
}

// The note stamped on a HealthKit-imported run, e.g. "Imported from Apple Watch".
export function hkImportedNote(bundleId?: string | null, sourceName?: string | null): string {
  return "Imported from " + hkOriginLabel(bundleId, sourceName);
}
