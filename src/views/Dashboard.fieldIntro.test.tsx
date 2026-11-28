import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ymd } from "../utils/format";
import type { Run, SettingsState } from "../types";

afterEach(cleanup);
vi.mock("../telemetry", () => ({ track: vi.fn() }));
vi.mock("../components/races/FieldIntroCard", () => ({
  FieldIntroCard: ({ candidates, onSeen }: { candidates: string[]; onSeen: () => void }) =>
    <button type="button" onClick={onSeen}>intro {candidates.join(",")}</button>,
}));
const { Dashboard } = await import("./Dashboard");

const NOW = new Date("2026-03-10T18:00:00");
vi.useFakeTimers({ shouldAdvanceTime: true });
vi.setSystemTime(NOW);
const TODAY = ymd(NOW);

const settings = { raceDate: "", distanceKm: "", goalSec: "" } as unknown as SettingsState;
const races = { participations: [{ editionId: "e1", raceDate: "2026-06-01", status: "wishlist" }], seenBadges: null };

const renderDash = (over: Record<string, unknown> = {}) => {
  const props = {
    runs: [] as Run[], plan: null, settings, races,
    goTab: vi.fn(), goProgress: vi.fn(), goLog: vi.fn(), toggleSess: vi.fn(), skipSess: vi.fn(),
    openSettings: vi.fn(), openCoach: vi.fn(), showToast: vi.fn(),
    stretchLog: [], openStretch: vi.fn(), saveSettings: vi.fn(),
    ...over,
  };
  render(<Dashboard {...(props as unknown as React.ComponentProps<typeof Dashboard>)} />);
  return props;
};

describe("Dashboard race field intro", () => {
  it("takes the attention slot for a runner who hasn't seen it, existing runners included", () => {
    const p = renderDash();
    fireEvent.click(screen.getByRole("button", { name: "intro e1" }));
    expect(p.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ raceFieldIntroSeen: true }));
  });

  it("never comes back once seen", () => {
    renderDash({ settings: { ...settings, raceFieldIntroSeen: true } });
    expect(screen.queryByRole("button", { name: /^intro/ })).toBeNull();
  });

  it("needs an upcoming race on the list", () => {
    renderDash({ races: { participations: [{ editionId: "e1", raceDate: "2026-01-01", status: "wishlist" }], seenBadges: null } });
    expect(screen.queryByRole("button", { name: /^intro/ })).toBeNull();
  });

  it("waits behind anything more pressing", () => {
    const run = { id: "r1", date: TODAY, type: "EASY", km: 10.2, durationSec: 3300 } as Run;
    renderDash({ runs: [run] });
    expect(screen.getByText("Cool down · 7 min")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^intro/ })).toBeNull();
  });
});
