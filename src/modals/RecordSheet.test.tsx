import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RecordSheet } from "./RecordSheet";
import { dismissTop } from "../utils/backDismiss";

afterEach(cleanup);

const setup = () => {
  const handlers = { onTrack: vi.fn(), onIndoor: vi.fn(), onManual: vi.fn(), onClose: vi.fn() };
  render(<RecordSheet {...handlers}/>);
  return handlers;
};

describe("RecordSheet", () => {
  it("offers the three ways to record, and not file import", () => {
    setup();
    expect(screen.getByText("Track a run live")).toBeInTheDocument();
    expect(screen.getByText("Indoor session")).toBeInTheDocument();
    expect(screen.getByText("Enter it manually")).toBeInTheDocument();
    // Import is account admin (Settings -> Integrations), not a way to record
    // today's run — keeping it here is what made this screen a hub.
    expect(screen.queryByText(/Import/i)).not.toBeInTheDocument();
  });

  it.each([
    ["Track a run live", "onTrack"],
    ["Indoor session", "onIndoor"],
    ["Enter it manually", "onManual"],
  ] as const)("%s closes the sheet and runs its action", (label, key) => {
    const h = setup();
    fireEvent.click(screen.getByText(label));
    expect(h[key]).toHaveBeenCalledTimes(1);
    // Closed first: the destination is a screen or a full-screen recorder, and
    // a sheet left registered would eat the next back press.
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Android back / Escape via the dismiss registry", () => {
    const h = setup();
    expect(dismissTop()).toBe(true);
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });
});
