import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ConnectionsCard } from "./ConnectionsCard";
import { PLAY_STORE_URL, TESTFLIGHT_BETA_URL } from "../constants";
import type { SettingsState } from "../types";

afterEach(cleanup);

const settings = {} as SettingsState;

// WEB rendering (isNative is false under jsdom): the native-only rows must NOT
// render as disabled controls — they collapse into the single mobile-app
// pointer with store links. Polar is dormant (no VITE_POLAR_CLIENT_ID in
// tests), so no cloud row either.
describe("ConnectionsCard (web)", () => {
  it("shows the card with a mobile-app pointer instead of native rows", async () => {
    render(<ConnectionsCard settings={settings} saveSettings={() => {}} />);
    expect(screen.getByText("Connections & sync")).toBeInTheDocument();
    // Native-only rows absent…
    expect(screen.queryByText("Bluetooth heart-rate sensor")).toBeNull();
    expect(screen.queryByText("Heart rate after runs")).toBeNull();
    // …replaced by ONE pointer to the mobile apps.
    const android = screen.getByRole("link", { name: "Get it on Google Play" });
    expect(android).toHaveAttribute("href", PLAY_STORE_URL);
    // APP_STORE_URL is still empty pre-App-Store-listing → TestFlight opt-in.
    const ios = screen.getByRole("link", { name: "Get it for iPhone" });
    expect(ios).toHaveAttribute("href", TESTFLIGHT_BETA_URL);
    // Unconfigured Polar renders nothing.
    expect(screen.queryByText("Polar")).toBeNull();
  });
});
