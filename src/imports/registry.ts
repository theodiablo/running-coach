import { healthConnectProvider } from "./providers/healthConnect";
import { healthKitProvider } from "./providers/healthkit";
import { fileProvider } from "./providers/file";
import { garminCloudProvider } from "./providers/cloud";
import { polarProvider, completePolarAuth } from "./providers/polar";
import { getSeenIds } from "../watch/import";
import { isDuplicateRun } from "./dedupe";
import type { CloudAuthResult } from "./cloudOauth";
import type { ImportProvider, ImportedRun } from "./types";
import type { Run } from "../types";

// Every import integration the app knows about. Adding one = implement
// ImportProvider (see types.ts) and list it here — scanning, dedupe, the
// Integrations settings panel and the file picker all pick it up from this list.
export const importProviders: ImportProvider[] = [
  healthConnectProvider, // Android
  healthKitProvider,     // iOS — never both: each isAvailable() checks its platform
  fileProvider,
  polarProvider,       // web cloud: isAvailable() is false until VITE_POLAR_CLIENT_ID is set
  garminCloudProvider, // scaffold: isAvailable() is false until actually wired
];

// One OAuth-return completer per cloud provider. RunningCoach runs every entry
// at boot and on the "rc-cloud-oauth-return" deep-link event — each is a no-op
// ("idle") unless that provider's return is actually stashed, so the fan-out is
// free on normal loads.
export const cloudAuthCompleters: Record<string, () => Promise<CloudAuthResult>> = {
  polar: completePolarAuth,
};

// The on-device health-store providers (one per platform) share the synced
// settings.watchImport enable-flag — it means "import finished runs from my
// phone's health store", a platform-neutral preference; the per-device auth
// markers stay separate. Anything newer gets its own settings.imports[id] key.
export const healthStoreProviderIds = new Set([healthConnectProvider.id, healthKitProvider.id]);
export const providerEnabledInSettings = (
  settings: { watchImport?: boolean; imports?: Record<string, boolean> },
  id: string,
): boolean =>
  healthStoreProviderIds.has(id) ? !!settings.watchImport : !!settings.imports?.[id];

export const getProvider = (id: string) => importProviders.find(p => p.id === id) || null;

type ScanAllOptions = {
  days?: number;
  now?: number;
  // Caller-supplied preference gate (e.g. settings.watchImport for the Health
  // Connect provider). Providers themselves only check device-local state.
  enabled?: (p: ImportProvider) => boolean;
  // Free-form label ("auto"/"manual") forwarded to providers for diagnostics.
  trigger?: string;
};

// Run every scan-capable, available, enabled provider and return the merged,
// deduped list of new runs. Sequential on purpose: each provider scans against
// the stored runs PLUS what earlier providers already produced, and every
// candidate passes isDuplicateRun against that same accumulating set — so the
// same run arriving from two sources collapses to one. Never throws; a failing
// provider contributes nothing.
export async function scanAllProviders(runs: Run[], opts: ScanAllOptions = {}): Promise<ImportedRun[]> {
  const found: ImportedRun[] = [];
  const seenIds = getSeenIds();
  for (const p of importProviders) {
    if (!p.scan) continue;
    try {
      if (!(await p.isAvailable())) continue;
      if (opts.enabled && !opts.enabled(p)) continue;
      const candidates = await p.scan((runs || []).concat(found as Run[]), { days: opts.days, now: opts.now, trigger: opts.trigger });
      for (const cand of candidates || []) {
        // Recompute per candidate so a batch also dedupes against itself.
        if (!isDuplicateRun(cand, (runs || []).concat(found as Run[]), seenIds)) found.push(cand);
      }
    } catch { /* provider failed — skip it, others still run */ }
  }
  return found;
}
