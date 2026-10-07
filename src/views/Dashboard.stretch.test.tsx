import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Dashboard } from "./Dashboard";
import { ymd } from "../utils/format";
import type { Run, SettingsState } from "../types";

afterEach(cleanup);
vi.mock("../telemetry", () => ({ track: vi.fn() }));

const NOW = new Date("2026-03-10T18:00:00");
vi.useFakeTimers({ shouldAdvanceTime: true });
vi.setSystemTime(NOW);
const TODAY = ymd(NOW);

const settings = { raceDate: "", distanceKm: "", goalSec: "" } as unknown as SettingsState;
const run = { id: "r1", date: TODAY, type: "EASY", km: 10.2, durationSec: 3300 } as Run;

const renderDash = (over: Record<string, unknown> = {}) => {
  const props = {
    runs: [run], plan: null, settings, races: null,
    goTab: vi.fn(), goProgress: vi.fn(), goLog: vi.fn(), toggleSess: vi.fn(), skipSess: vi.fn(),
    openSettings: vi.fn(), openCoach: vi.fn(), showToast: vi.fn(),
    isPremium: true, stretchLog: [], openStretch: vi.fn(), saveSettings: vi.fn(),
    ...over,
  };
  render(<Dashboard {...(props as unknown as React.ComponentProps<typeof Dashboard>)} />);
  return props;
};

describe("Dashboard stretch banner", () => {
  it("offers the cool-down after a run today and opens it", () => {
    const p = renderDash();
    expect(screen.getByText("Cool down · 7 min")).toBeInTheDocument();
    expect(screen.getByText("After your 10.2 km. Calves, quads and hips.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Start"));
    expect(p.openStretch).toHaveBeenCalledWith({ routine: "cooldown", focus: "standard", km: 10.2 });
  });

  it("is absent for a free account", () => {
    renderDash({ isPremium: false });
    expect(screen.queryByText("Cool down · 7 min")).toBeNull();
  });

  it("hides until tomorrow on 'Not today', and says how to turn it off", () => {
    const p = renderDash();
    fireEvent.click(screen.getByRole("button", { name: "Not today" }));
    expect(p.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ stretchDismissed: TODAY }));
    expect(p.showToast).toHaveBeenCalledWith(expect.stringContaining("Settings"));
  });

  it("respects the suggestions setting", () => {
    renderDash({ settings: { ...settings, stretchSuggest: false } });
    expect(screen.queryByText("Cool down · 7 min")).toBeNull();
  });
});
