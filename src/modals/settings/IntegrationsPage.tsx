import { ConnectionsCard } from "../../views/ConnectionsCard";
import { VendorGuides } from "./VendorGuides";
import type { SettingsState } from "../../types";

// Integrations: everything that feeds runs or heart rate in from outside.
// ConnectionsCard holds the sources we can actually connect to; VendorGuides
// covers the ones we can only explain (Strava, Zepp) — see its header.
type IntegrationsPageProps = {
  settings: SettingsState;
  saveSettings: (settings: SettingsState) => void;
  showToast?: (msg: string, type?: string) => void;
  scanImportsNow?: () => Promise<number>;
  onImportFile?: () => void;
};

export function IntegrationsPage({ onImportFile, ...connectionProps }: IntegrationsPageProps) {
  return (
    <>
      <ConnectionsCard {...connectionProps}/>
      <VendorGuides onImportFile={onImportFile}/>
    </>
  );
}
