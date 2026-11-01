import type { Run } from "../types";
import type { TrackPointOrGap } from "../utils/geo";
import type { HrSample } from "./series";

// A partial Run plus three TRANSIENT fields, all stripped by
// persistImportedRoute before addRuns: points (→ routeId), hrSamples (→
// hrRouteId when there are no points), and providerId (stamped by the registry,
// names the source in the import toast).
export type ImportedRun = Partial<Run> & {
  points?: TrackPointOrGap[];
  hrSamples?: HrSample[];
  providerId?: string;
};

export type ImportParseResult = { runs: ImportedRun[]; error?: string | null };

// One pluggable source of finished runs: "healthconnect", "healthkit", "file" (user-picked, never scanned), "cloud"
// (OAuth + server poll). Add one by implementing this and registering it in registry.ts; dedupe and save are provider-agnostic.
export type ImportProvider = {
  id: string;
  label: string;
  kind: "healthconnect" | "healthkit" | "file" | "cloud";
  platform: "native" | "web" | "both";
  // Right platform, plugin present, config set. Unavailable ones are skipped
  // by scans and hidden by the UI.
  isAvailable: () => Promise<boolean> | boolean;
  // Per-device: a synced preference alone is never enough.
  isConnected?: () => Promise<boolean> | boolean;
  // true/false for an in-place grant; "pending" when the flow leaves the app
  // and the outcome arrives by deep link — the caller must not toast on
  // "pending". A web redirect provider never settles (the page navigates away).
  connect?: () => Promise<boolean | "pending">;
  disconnect?: () => void;
  // New (deduped) runs since `days` ago; `trigger` labels the scan for logs.
  scan?: (runs: Run[], opts?: { days?: number; now?: number; trigger?: string }) => Promise<ImportedRun[]>;
  // Text formats read `text`, binary (FIT) reads `bytes`; the caller populates
  // one from the extension.
  parse?: (file: { name: string; text: string; bytes?: Uint8Array }) => ImportParseResult;
  help?: string;   // how to enable the source, shown in the UI
  fileAccept?: string; // <input accept> list
};
