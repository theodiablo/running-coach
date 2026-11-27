import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RunReview } from "./RunReview";
import type { Run } from "../types";
import type { RunPrefill } from "../utils/runPrefill";
import type { SessionWithWeek } from "../utils/overdue";

vi.mock("../telemetry", () => ({ track: vi.fn() }));
afterEach(cleanup);

// Yesterday's real run, as the tracker hands it over.
const gps: RunPrefill = {
  date: "2026-11-25", type: "EASY", km: 6.35, durationSec: 2317, elevation: 158, hr: 147, hrMax: 173,
  source: "gps", routeId: "r1", bestEfforts: { "5k": 1831 }, startedAt: "2026-11-25T20:04:19.832Z",
  previewTrack: [[43.2702, -2.0114, 0, 135], [43.275, -2.0, 1, 140], [43.2703, -2.0117, 2, 133]],
};

const setup = (prefill: RunPrefill = gps) => {
  const addRuns = vi.fn((rs: Partial<Run>[]) => rs.map((r, i) => ({ ...r, id: "new" + i } as Run)));
  const onSaved = vi.fn();
  const onDone = vi.fn();
  const view = render(<RunReview addRuns={addRuns} onDone={onDone} onSaved={onSaved} prefill={prefill}/>);
  return { addRuns, onSaved, onDone, view };
};
const save = () => fireEvent.click(screen.getByRole("button", { name: /^(Save|✓)|Save/ }));
const savedRun = (addRuns: ReturnType<typeof setup>["addRuns"]) => addRuns.mock.calls[0][0][0];
const correct = () => fireEvent.click(screen.getByRole("button", { name: "Correct a number" }));

describe("RunReview · the measured run is shown, not asked", () => {
  it("shows distance, time and pace as a summary with no editable field", () => {
    setup();
    expect(screen.getByText("Save your run")).toBeInTheDocument();
    expect(screen.getByText("6.35")).toBeInTheDocument();
    expect(screen.getByText("38:37")).toBeInTheDocument();
    expect(screen.getByText("6:05")).toBeInTheDocument();
    expect(screen.getByText("Measured by GPS")).toBeInTheDocument();
    expect(screen.queryByLabelText("Distance (km)")).toBeNull();
    expect(screen.queryByLabelText("Duration")).toBeNull();
  });

  it("draws the route line from the recorder's trace, and saves the run without it", () => {
    const { addRuns, view } = setup();
    expect(view.container.querySelector("svg path")?.getAttribute("d")).toMatch(/^M/);
    save();
    expect(savedRun(addRuns)).not.toHaveProperty("previewTrack");
  });

  it("saves the measurement untouched when nothing is corrected", () => {
    const { addRuns, onDone } = setup();
    save();
    expect(savedRun(addRuns)).toMatchObject({
      date: "2026-11-25", type: "EASY", km: 6.35, durationSec: 2317, elevation: 158, hr: 147, hrMax: 173,
      routeId: "r1", source: "gps", bestEfforts: { "5k": 1831 }, startedAt: "2026-11-25T20:04:19.832Z",
    });
    expect(onDone).toHaveBeenCalled();
  });
});

describe("RunReview · correcting a number is a deliberate step", () => {
  it("warns on an impossible pace and puts the recorded time back", () => {
    const { addRuns } = setup();
    correct();
    // The slip behind the 4:23 run: 38:37 with its last digit popped.
    fireEvent.change(screen.getByLabelText("Duration"), { target: { value: "383" } });
    expect(screen.getByText(/unusually fast/)).toBeInTheDocument();
    expect(screen.getByText("Corrected by you")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Use the recorded 6.35 km, 38:37/ }));
    expect(screen.queryByText(/unusually fast/)).toBeNull();
    save();
    expect(savedRun(addRuns)).toMatchObject({ durationSec: 2317 });
  });

  it("still saves a correction the runner means", () => {
    const { addRuns } = setup();
    correct();
    fireEvent.change(screen.getByLabelText("Distance (km)"), { target: { value: "6.5" } });
    expect(screen.getByText("Recorded: 6.35")).toBeInTheDocument();
    save();
    expect(savedRun(addRuns)).toMatchObject({ km: 6.5, routeId: "r1" });
  });

  it("opens by itself when the measurement can't be saved as it is", () => {
    setup({ ...gps, km: 0 });
    expect(screen.getByLabelText("Distance (km)")).toBeInTheDocument();
  });
});

describe("RunReview · the questions only the runner can answer", () => {
  it("asks the kind of run as one tap, and never offers Other on a run", () => {
    const { addRuns } = setup();
    expect(screen.getByRole("button", { name: "Easy" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Other" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tempo" }));
    save();
    expect(savedRun(addRuns)).toMatchObject({ type: "TEMPO" });
  });

  it("starts effort unanswered, saves a tap, and clears on a second tap", () => {
    const { addRuns } = setup();
    const seven = screen.getByRole("button", { name: "Effort 7 out of 10" });
    expect(screen.getAllByRole("button", { pressed: true }).map(b => b.textContent)).toEqual(["Easy"]);
    fireEvent.click(seven);
    expect(screen.getByText("7/10")).toBeInTheDocument();
    fireEvent.click(seven);
    fireEvent.click(screen.getByRole("button", { name: "Effort 4 out of 10" }));
    save();
    expect(savedRun(addRuns)).toMatchObject({ effort: 4 });
  });

  it("saves an unanswered effort as null, never a middle value", () => {
    const { addRuns } = setup();
    save();
    expect(savedRun(addRuns).effort).toBeNull();
  });

  it("keeps notes", () => {
    const { addRuns } = setup();
    fireEvent.change(screen.getByLabelText(/Anything to remember/), { target: { value: "New shoes" } });
    save();
    expect(savedRun(addRuns)).toMatchObject({ notes: "New shoes" });
  });
});

describe("RunReview · arrivals", () => {
  it("asks an indoor session which machine, with no distance", () => {
    const { addRuns } = setup({ date: "2026-11-25", type: "OTHER", km: 0, durationSec: 2700, hr: 132, hrMax: 158,
      source: "indoor", hrRouteId: "h1", bestEfforts: {} });
    expect(screen.getByText("Save your session")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Easy" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Bike" }));
    fireEvent.click(screen.getByRole("button", { name: "Save session" }));
    expect(savedRun(addRuns)).toMatchObject({ type: "OTHER", activity: "bike", km: 0, durationSec: 2700, source: "indoor", hrRouteId: "h1" });
  });

  // The saved run is the provider's only record that the workout landed.
  it("carries a cloud import's identity and note, and isn't a fresh run", () => {
    const { addRuns } = setup({ date: "2026-08-15", type: "EASY", km: 8.2, durationSec: 3000,
      source: "watch", extId: "suunto:abc123", routeId: "r9", notes: "Imported from Suunto" });
    expect(screen.getByText("From your watch")).toBeInTheDocument();
    save();
    expect(savedRun(addRuns)).toMatchObject({ extId: "suunto:abc123", routeId: "r9", source: "watch", notes: "Imported from Suunto" });
    expect((addRuns.mock.calls[0] as unknown[])[1]).toEqual({ celebrated: false, fresh: false });
  });

  it("tells the hub a recorded run was already celebrated", () => {
    const { addRuns } = setup({ ...gps, celebrated: true });
    save();
    expect((addRuns.mock.calls[0] as unknown[])[1]).toEqual({ celebrated: true, fresh: true });
    expect(savedRun(addRuns)).not.toHaveProperty("celebrated");
  });

  it("says heart rate is on its way from the phone's health store", () => {
    setup({ ...gps, hr: undefined, hrMax: undefined, hrPending: { start: 1, end: 2, source: "healthconnect" } });
    expect(screen.getByText(/added automatically from Health Connect/)).toBeInTheDocument();
  });
});

// A run recorded on Wednesday for Thursday's session: an OFFER to confirm or decline, never a silent tick.
describe("RunReview · the session a recorded run is offered", () => {
  const offered = { id: "w3d3", wNum: 3, date: "2026-03-12", type: "TEMPO", desc: "Tempo 8km", km: 8, pace: 300 } as unknown as SessionWithWeek;
  const withOffer: RunPrefill = { date: "2026-03-11", type: "TEMPO", km: 8.2, durationSec: 2412, source: "gps", session: offered, sessionOffered: true };

  it("says which session it counts toward, and that its type came from the plan", () => {
    setup(withOffer);
    expect(screen.getByText(/Counts toward your session on/)).toBeInTheDocument();
    expect(screen.getByText("Picked from your plan.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save and tick off/ })).toBeInTheDocument();
  });

  it("ticks that session off on save, and keeps the offer out of the run", () => {
    const { addRuns, onSaved } = setup(withOffer);
    save();
    expect(onSaved).toHaveBeenCalledWith([expect.objectContaining({ id: "new0" })], { wNum: 3, sId: "w3d3" });
    expect(savedRun(addRuns)).not.toHaveProperty("session");
    expect(savedRun(addRuns)).not.toHaveProperty("sessionOffered");
  });

  it("saves the run on its own once declined, and lets the decline be taken back", () => {
    const { onSaved } = setup(withOffer);
    fireEvent.click(screen.getByRole("button", { name: "Not this one" }));
    expect(screen.queryByText(/Counts toward your session on/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Actually, count it/ }));
    expect(screen.getByText(/Counts toward your session on/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Not this one" }));
    save();
    expect(onSaved).toHaveBeenCalledWith(expect.anything(), null);
  });

  it("lets go of the session when the run is re-dated out of its window", () => {
    const { onSaved } = setup(withOffer);
    correct();
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-02-20" } });
    expect(screen.getByText(/no longer match/)).toBeInTheDocument();
    save();
    expect(onSaved).toHaveBeenCalledWith(expect.anything(), null);
  });

  it("does not offer to decline a session the runner chose", () => {
    setup({ ...withOffer, date: "2026-03-12", sessionOffered: false });
    expect(screen.queryByRole("button", { name: "Not this one" })).toBeNull();
    expect(screen.getByText(/Week 3/)).toBeInTheDocument();
  });
});

describe("RunReview · a walk", () => {
  it("doesn't call a slow hike from the watch a mistake", () => {
    setup({ date: "2026-11-22", type: "WALK", km: 3, durationSec: 4200, source: "watch", hcId: "hc-9" });
    expect(screen.queryByLabelText("Distance (km)")).toBeNull();
    expect(screen.queryByText(/slower than walking/)).toBeNull();
    expect(screen.getByRole("button", { name: "Walk" })).toHaveAttribute("aria-pressed", "true");
  });
});
