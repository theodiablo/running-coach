import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LogView } from "./LogView";

// LogView used to be the app's "Record a Run" hub: both recorders, the manual
// form and a file-import panel on one screen, whatever you had come to do.
// Choosing how to record is now RecordSheet's job, so these guard the split —
// each arrival shows one thing.

vi.mock("../telemetry", () => ({ track: vi.fn() }));

const noop = () => {};
const addNone = () => [];
const setup = (props: Partial<Parameters<typeof LogView>[0]> = {}) =>
  render(<LogView addRuns={addNone} onDone={noop} runs={[]} {...props}/>);

afterEach(cleanup);

describe("LogView", () => {
  it("offers no recorder: the sheet already asked how the run happened", () => {
    setup();
    expect(screen.getByText("Enter a run")).toBeInTheDocument();
    expect(screen.queryByText(/Track a run live/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Indoor session/i)).not.toBeInTheDocument();
  });

  it("names the plan session being logged, and that saving ticks it off", () => {
    setup({ prefill: { date: "2026-08-18", type: "TEMPO", km: 8, pace: 310,
      session: { id: "w3-tue", wNum: 3, date: "2026-08-18", type: "TEMPO", desc: "Tempo 8km", km: 8, pace: 310 } } });
    expect(screen.getByText("Log this session")).toBeInTheDocument();
    expect(screen.getByText(/Week 3/)).toBeInTheDocument();
    expect(screen.getByText(/8 km at 5:10\/km/)).toBeInTheDocument();
    expect(screen.getByText("Saving this marks the session done.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save and tick off/ })).toBeInTheDocument();
  });

  // A cross-training session's km is synthetic (see planSessionPrefill), so the
  // prefill carries a duration instead — the banner must not claim a distance.
  it("states a cross-training session's duration rather than a distance", () => {
    setup({ prefill: { date: "2026-08-19", type: "OTHER", durationSec: 2400,
      session: { id: "w3-wed", wNum: 3, date: "2026-08-19", type: "OTHER", desc: "Cross-training", km: 6, pace: 400, sd: { kind: "cross", minutes: 40 } } } });
    expect(screen.getByText(/Cross-training · 40min/)).toBeInTheDocument();
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

    setup({ prefill: { date: "2026-08-18", type: "TEMPO", km: 8,
      session: { id: "w3-tue", wNum: 3, date: "2026-08-18", type: "TEMPO", desc: "Tempo 8km", km: 8, pace: 310 } } });
    expect(screen.queryByText(/Got a file from your watch/)).not.toBeInTheDocument();
  });

});

// The form rebuilds the run from its own fields; anything else the prefill carried rides through.
describe("LogView save", () => {
  it("lets the form win over the prefill it was seeded from", () => {
    const addRuns = vi.fn();
    setup({ addRuns, prefill: { date: "2026-08-23", type: "EASY", km: 10, durationSec: 3000 } });
    fireEvent.change(screen.getByLabelText(/Distance/i), { target: { value: "9.5" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(addRuns.mock.calls[0][0][0]).toMatchObject({ km: 9.5, durationSec: 3000 });
  });

  it("warns on an impossible pace but still saves", () => {
    const addRuns = vi.fn();
    setup({ addRuns });
    fireEvent.change(screen.getByLabelText("Distance (km)"), { target: { value: "6.35" } });
    fireEvent.change(screen.getByLabelText("Duration"), { target: { value: "383" } });
    expect(screen.getByText(/faster than any runner/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Save run/ }));
    expect(addRuns).toHaveBeenCalledTimes(1);
  });
});
