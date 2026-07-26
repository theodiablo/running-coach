import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { SettingsState } from "../types";

// A live cloud provider (Polar is dormant in tests — no VITE_POLAR_CLIENT_ID),
// mocked at the registry seam so the row renders without any OAuth machinery.
vi.mock("../imports/registry", () => ({
  importProviders: [{
    id: "polar",
    kind: "cloud",
    label: "Polar",
    isAvailable: async () => true,
    isConnected: async () => false,
    connect: async () => false,
    scan: async () => [],
  }],
  healthStoreProviderIds: new Set(["healthconnect", "healthkit"]),
  providerEnabledInSettings: () => false,
}));

import { ConnectionsCard } from "./ConnectionsCard";

afterEach(cleanup);

describe("ConnectionsCard cloud row", () => {
  // Regression: the provider's own help and the card-wide footnote were both
  // labelled "How it works" and rendered back to back under the Polar row, so
  // the section read as duplicated and neither label said what it covered.
  it("names the provider in its help label, distinct from the card footnote", async () => {
    render(<ConnectionsCard settings={{} as SettingsState} saveSettings={() => {}} />);
    const help = await screen.findByRole("button", { name: "How Polar works" });
    expect(screen.getByRole("button", { name: "About these connections" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "How it works" })).toBeNull();

    // And it still explains Polar specifically once opened.
    fireEvent.click(help);
    expect(await screen.findByText(/import finished runs/)).toBeInTheDocument();
  });
});
