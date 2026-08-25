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

  // A single imported run is reviewed through this form, and the saved run is
  // the provider's only record that the workout landed. Dropping extId left
  // knownKeys permanently empty: every later sync re-listed the workout,
  // re-downloaded its FIT against the daily quota, then discarded the candidate
  // as a duplicate — so a working sync reported "no new runs".
  it("carries a cloud import's identity through the review", () => {
    const addRuns = vi.fn();
    setup({
      addRuns,
      prefill: {
        date: "2026-08-15", type: "EASY", km: 8.2, durationSec: 3000,
        source: "watch", extId: "suunto:abc123", routeId: "r9",
        notes: "Imported from Suunto",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save run/ }));
    expect(addRuns).toHaveBeenCalledTimes(1);
    expect(addRuns.mock.calls[0][0][0]).toMatchObject({
      extId: "suunto:abc123",
      routeId: "r9",
      source: "watch",
      notes: "Imported from Suunto",
    });
  });
});

// The review form rebuilds the run from its own fields, so anything the
// recorder measured that the form cannot edit has to be carried across it.
// This is where `extId` was lost once already (every later cloud sync then
// reported "no new runs"), so the boundary is pinned end to end rather than
// only at carryPrefill.
describe("LogView save carries what the recorder measured", () => {
  const save = () => fireEvent.click(screen.getByRole("button", { name: /Save/ }));

  it("keeps a tracked run's trace and measured efforts", () => {
    const addRuns = vi.fn();
    setup({ addRuns, prefill: {
      date: "2026-08-23", type: "EASY", km: 10, durationSec: 3000,
      source: "gps", routeId: "r1", hr: 150, hrMax: 172,
      bestEfforts: { "5k": 1200 }, startedAt: "2026-08-23T06:00:00.000Z",
    } });
    save();
    expect(addRuns).toHaveBeenCalledTimes(1);
    expect(addRuns.mock.calls[0][0][0]).toMatchObject({
      routeId: "r1", source: "gps", bestEfforts: { "5k": 1200 },
      startedAt: "2026-08-23T06:00:00.000Z",
    });
  });

  // The one that actually bit: a cloud import's workout key. Without it the run
  // is invisible to the provider's knownKeys and every later sync re-lists it.
  it("keeps a cloud import's workout key", () => {
    const addRuns = vi.fn();
    setup({ addRuns, prefill: {
      date: "2026-08-23", type: "EASY", km: 10, durationSec: 3000,
      source: "watch", extId: "suunto:123", notes: "Imported from Suunto",
    } });
    save();
    expect(addRuns.mock.calls[0][0][0]).toMatchObject({ extId: "suunto:123" });
  });

  // `activity` reaches the run through the FORM (it is seeded and re-emitted by
  // runFormToPatch), not through the carry — asserted here so a future change to
  // either half can't quietly drop it.
  it("keeps an indoor session's machine and its provenance", () => {
    const addRuns = vi.fn();
    setup({ addRuns, prefill: {
      date: "2026-08-23", type: "OTHER", km: 0, durationSec: 2700,
      source: "indoor", activity: "bike", hrRouteId: "h1", bestEfforts: {},
    } });
    save();
    expect(addRuns.mock.calls[0][0][0]).toMatchObject({
      type: "OTHER", activity: "bike", source: "indoor", hrRouteId: "h1",
    });
  });

  it("still lets the form win over the prefill it was seeded from", () => {
    const addRuns = vi.fn();
    setup({ addRuns, prefill: {
      date: "2026-08-23", type: "EASY", km: 10, durationSec: 3000, source: "gps", routeId: "r1",
    } });
    fireEvent.change(screen.getByLabelText(/Distance/i), { target: { value: "9.5" } });
    save();
    expect(addRuns.mock.calls[0][0][0]).toMatchObject({ km: 9.5, routeId: "r1" });
  });
});
