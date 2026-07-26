import type { ImportProvider, ImportedRun } from "../types";
import type { Run } from "../../types";

// Cloud-provider scaffold — interface only, not a user-visible feature until a
// vendor OAuth integration is wired server-side (mirrors coach-agent/polar-import:
// secret never ships client-side). Until configured, isAvailable() is false so
// no "coming soon" placeholder renders. Strava is deliberately excluded: its API
// terms ban AI use of the data, and the coach reads runs from app_state — users
// can still import their own Strava exports via the file provider.
export type CloudProviderConfig = {
  id: string;
  label: string;
  // Set when the integration is actually wired (server function deployed and a
  // client id configured, e.g. via a VITE_* env). Absent → provider disabled.
  clientId?: string;
  connect?: () => Promise<boolean>;
  scan?: (runs: Run[], opts?: { days?: number; now?: number }) => Promise<ImportedRun[]>;
};

export function makeCloudProvider(config: CloudProviderConfig): ImportProvider {
  const enabled = !!config.clientId;
  return {
    id: config.id,
    label: config.label,
    kind: "cloud",
    platform: "both",
    isAvailable: () => enabled,
    isConnected: () => false,
    connect: async () => {
      if (!enabled || !config.connect) return false;
      return config.connect();
    },
    scan: async (runs, opts) => {
      if (!enabled || !config.scan) return []; // not enabled — silently contributes nothing
      return config.scan(runs, opts);
    },
  };
}

// Example registration proving the wiring end-to-end while staying invisible
// (no VITE_GARMIN_CLIENT_ID exists, so isAvailable() is false everywhere).
export const garminCloudProvider = makeCloudProvider({
  id: "garmin",
  label: "Garmin Connect",
  clientId: import.meta.env?.VITE_GARMIN_CLIENT_ID,
});
