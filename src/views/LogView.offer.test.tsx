import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LogView } from "./LogView";
import type { Run } from "../types";
import type { SessionWithWeek } from "../utils/overdue";

// A run recorded on Wednesday for Thursday's session. The recorder hands the
// save screen an OFFER: the session it thinks this settled, named and dated, to
// confirm or decline. Never a silent tick — that was the bug #221 fixed.

vi.mock("../telemetry", () => ({ track: vi.fn() }));
afterEach(cleanup);

const offered = {
  id: "w3d3", wNum: 3, date: "2026-03-12", type: "TEMPO", desc: "Tempo 8km", km: 8, pace: 300,
} as unknown as SessionWithWeek;

const setup = (props: Partial<Parameters<typeof LogView>[0]> = {}) => {
  const addRuns = vi.fn((rs: Partial<Run>[]) => rs.map((r, i) => ({...r, id: "new" + i} as Run)));
  const onSaved = vi.fn();
  render(<LogView addRuns={addRuns} onDone={() => {}} onSaved={onSaved} runs={[]}
    prefill={{date: "2026-03-11", type: "TEMPO", km: 8.2, durationSec: 2412, source: "gps",
      session: offered, sessionOffered: true}}
    {...props}/>);
  return { addRuns, onSaved };
};

const save = () => fireEvent.click(screen.getByRole("button", {name: /Save/}));

describe("LogView · the session a recorded run is offered", () => {
  it("says which session it counts toward, on top of the recorder's own banner", () => {
    setup();
    expect(screen.getByText(/Counts toward your session on/)).toBeInTheDocument();
    expect(screen.getByText(/Saved from your tracked run|GPS/i)).toBeInTheDocument();
  });

  it("ticks that session off on save", () => {
    const { onSaved } = setup();
    save();
    expect(onSaved).toHaveBeenCalledWith([expect.objectContaining({id: "new0"})], {wNum: 3, sId: "w3d3"});
  });

  it("saves the run on its own once declined", () => {
    const { onSaved } = setup();
    fireEvent.click(screen.getByRole("button", {name: "Not this one"}));
    expect(screen.queryByText(/Counts toward your session on/)).toBeNull();
    save();
    expect(onSaved).toHaveBeenCalledWith([expect.objectContaining({id: "new0"})], null);
  });

  it("lets a decline be taken back — nothing has happened yet", () => {
    setup();
    fireEvent.click(screen.getByRole("button", {name: "Not this one"}));
    fireEvent.click(screen.getByRole("button", {name: /Actually, count it/}));
    expect(screen.getByText(/Counts toward your session on/)).toBeInTheDocument();
  });

  it("keeps the offer out of the saved run — it is not run data", () => {
    const { addRuns } = setup();
    save();
    expect(addRuns.mock.calls[0][0][0]).not.toHaveProperty("session");
    expect(addRuns.mock.calls[0][0][0]).not.toHaveProperty("sessionOffered");
  });

  // The runner can still edit the date and the type after the offer arrives, so
  // the link is re-checked against the form, not frozen from the prefill.
  it("lets go of the session when the run is edited into a bike ride", () => {
    const { onSaved } = setup();
    fireEvent.change(screen.getByLabelText(/Type/i), {target: {value: "OTHER"}});
    expect(screen.queryByText(/Counts toward your session on/)).toBeNull();
    expect(screen.getByText(/no longer match/)).toBeInTheDocument();
    save();
    expect(onSaved).toHaveBeenCalledWith(expect.anything(), null);
  });

  it("lets go of the session when the run is dated out of the window", () => {
    const { onSaved } = setup();
    fireEvent.change(screen.getByLabelText(/Date/i), {target: {value: "2026-02-20"}});
    expect(screen.getByText(/no longer match/)).toBeInTheDocument();
    save();
    expect(onSaved).toHaveBeenCalledWith(expect.anything(), null);
  });

  // A session the runner picked themselves is not an offer: it was already
  // chosen, so there is nothing to decline.
  it("does not offer to decline a session the runner chose", () => {
    setup({prefill: {date: "2026-03-12", type: "TEMPO", km: 8, pace: 300, session: offered}});
    expect(screen.queryByRole("button", {name: "Not this one"})).toBeNull();
    expect(screen.getByText(/Week 3/)).toBeInTheDocument();
  });
});
