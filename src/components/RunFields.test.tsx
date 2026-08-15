import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RunFields } from "./RunFields";
import { emptyRunForm, type RunFormValues } from "../utils/runForm";

// The form used to put all eleven inputs on one screen, which pushed Save below
// the fold and gave no sign that nine of them were optional. These pin the two
// tiers, the pace confirmation, and the cross-training shape.

afterEach(cleanup);

const setup = (over: Partial<RunFormValues> = {}, props: { detailsOpen?: boolean; errors?: { km: boolean; duration: boolean } } = {}) =>
  render(<RunFields form={{ ...emptyRunForm("2026-08-15"), ...over }} onChange={() => {}} phScope="log.fields" {...props}/>);

describe("RunFields", () => {
  it("keeps the optional fields behind one row until asked", () => {
    setup();
    expect(screen.queryByPlaceholderText("e.g. 145")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/Add heart rate/));
    expect(screen.getByPlaceholderText("e.g. 145")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("How did it feel? Any aches?")).toBeInTheDocument();
  });

  // A watch import or an edit arrives carrying HR and elevation; hiding data the
  // runner did not enter themselves would read as data loss.
  it("opens already expanded when the form arrives with detail", () => {
    setup({ hr: "148" }, { detailsOpen: true });
    expect(screen.getByDisplayValue("148")).toBeInTheDocument();
    expect(screen.queryByText(/Add heart rate/)).not.toBeInTheDocument();
  });

  it("confirms the entry with a pace once distance and duration are both in", () => {
    setup({ km: "8", dur: "4300" });
    expect(screen.getByText("5:23/km")).toBeInTheDocument();
  });

  // One masked field replaced three number boxes. It only ever appends or pops
  // a digit — the caret is pinned to the end — so these are the only two paths.
  it("shows the duration grouped as it will be read back", () => {
    setup({ dur: "15207" });
    expect(screen.getByDisplayValue("1:52:07")).toBeInTheDocument();
  });

  it("appends a typed digit and pops one on backspace", () => {
    const onChange = vi.fn();
    render(<RunFields form={{ ...emptyRunForm("2026-08-15"), dur: "430" }} onChange={onChange} phScope="log.fields"/>);
    const field = screen.getByDisplayValue("4:30");

    fireEvent.change(field, { target: { value: "4:300" } });
    expect(onChange).toHaveBeenCalledWith("dur", "4300");

    onChange.mockClear();
    fireEvent.keyDown(field, { key: "Backspace" });
    expect(onChange).toHaveBeenCalledWith("dur", "43");
  });

  it("shows no pace until it means something", () => {
    setup({ km: "8" });
    expect(screen.queryByText(/\/km$/)).not.toBeInTheDocument();
  });

  // The one door through which a bike's kilometres used to reach running volume,
  // badges and the plan's fitness signal.
  it("offers cross-training a machine but no distance, and says why", () => {
    setup({ type: "OTHER" });
    expect(screen.queryByPlaceholderText("e.g. 8.5")).not.toBeInTheDocument();
    expect(screen.getByText("Machine")).toBeInTheDocument();
    expect(screen.getByText(/No distance here/)).toBeInTheDocument();
  });

  it("puts a required-field message on the field it is about", () => {
    setup({ km: "8" }, { errors: { km: false, duration: true } });
    expect(screen.getByText(/How long did it take/)).toBeInTheDocument();
    expect(screen.queryByText(/How far did you go/)).not.toBeInTheDocument();
  });

  it("starts effort unset rather than answering it for you", () => {
    setup({}, { detailsOpen: true });
    expect(screen.getByText("not set")).toBeInTheDocument();
    expect(screen.getByLabelText("Perceived effort:")).toHaveValue("0");
  });
});
