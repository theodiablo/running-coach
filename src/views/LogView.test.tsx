import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LogView } from "./LogView";

// LogView used to be the app's "Record a Run" hub: both recorders, the manual
// form and a file-import panel on one screen, whatever you had come to do.
// Choosing how to record is now RecordSheet's job, so these guard the split —
// each arrival shows one thing.

vi.mock("../telemetry", () => ({ track: vi.fn() }));

const noop = () => {};
const setup = (props: Partial<Parameters<typeof LogView>[0]> = {}) =>
  render(<LogView addRuns={noop} onDone={noop} runs={[]} {...props}/>);

afterEach(cleanup);

describe("LogView", () => {
  it("offers no recorder: the sheet already asked how the run happened", () => {
    setup();
    expect(screen.getByText("Enter a run")).toBeInTheDocument();
    expect(screen.queryByText(/Track a run live/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Indoor session/i)).not.toBeInTheDocument();
  });

  it("names the plan session being logged, and that saving ticks it off", () => {
    setup({ prefill: { date: "2026-08-18", type: "TEMPO", km: 8, pace: 310, wNum: 3, sId: "w3-tue" } });
    expect(screen.getByText("Log this session")).toBeInTheDocument();
    expect(screen.getByText(/Week 3/)).toBeInTheDocument();
    expect(screen.getByText(/8 km at 5:10\/km/)).toBeInTheDocument();
    expect(screen.getByText("Saving this marks the session done.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save and tick off/ })).toBeInTheDocument();
  });

  // A cross-training session's km is synthetic (see planSessionPrefill), so the
  // prefill carries a duration instead — the banner must not claim a distance.
  it("states a cross-training session's duration rather than a distance", () => {
    setup({ prefill: { date: "2026-08-19", type: "OTHER", durationSec: 2400, wNum: 3, sId: "w3-wed" } });
    expect(screen.getByText(/Cross-training · 40min/)).toBeInTheDocument();
  });

  it("keeps the tracked-run review untouched", () => {
    setup({ prefill: { date: "2026-08-18", type: "EASY", km: 6.2, durationSec: 2100, source: "gps", routeId: "r1" } });
    expect(screen.getByText("Save your run")).toBeInTheDocument();
    expect(screen.getByText(/Tracked by GPS/)).toBeInTheDocument();
  });

  it("shows the importer alone, not stacked above the form", () => {
    setup({ openImport: true });
    expect(screen.getByText("Import a file")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose file" })).toBeInTheDocument();
    // Labelled fields, so this can't pass just because the query can't see them.
    expect(screen.queryByLabelText("Distance (km)")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Duration")).not.toBeInTheDocument();
  });

  // Import is otherwise a Settings task; this is its one entry point in the
  // recording flow, and only where someone might realise they have a file.
  it("links to the importer from a bare manual entry, but never from a prefill", () => {
    const { unmount } = setup();
    fireEvent.click(screen.getByText(/Got a file from your watch/));
    expect(screen.getByRole("button", { name: "Choose file" })).toBeInTheDocument();
    unmount();

    setup({ prefill: { date: "2026-08-18", type: "TEMPO", km: 8, wNum: 3, sId: "w3-tue" } });
    expect(screen.queryByText(/Got a file from your watch/)).not.toBeInTheDocument();
  });
});
