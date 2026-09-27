import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { StylePicker } from "./StylePicker";
import { RUNWALK_DEFAULT } from "../utils/runwalk";

afterEach(cleanup);

// The ratio control is the Run/Walk style's own knob, so it must not show up
// under any other style — and it is the only way to set the ratio, so it has to
// report a tap back to the form that saves it.
describe("StylePicker · run/walk ratio", () => {
  it("offers the ratio only when Run/Walk is the selected style", () => {
    const { rerender } = render(
      <StylePicker value="balanced" onChange={vi.fn()} runWalk={RUNWALK_DEFAULT} onRunWalkChange={vi.fn()}/>);
    expect(screen.queryByText(/run\/walk ratio/i)).toBeNull();
    rerender(<StylePicker value="runwalk" onChange={vi.fn()} runWalk={RUNWALK_DEFAULT} onRunWalkChange={vi.fn()}/>);
    expect(screen.getByText(/run\/walk ratio/i)).toBeTruthy();
  });

  it("stays out of the way when the form doesn't hand it a ratio", () => {
    render(<StylePicker value="runwalk" onChange={vi.fn()}/>);
    expect(screen.queryByText(/run\/walk ratio/i)).toBeNull();
  });

  it("reports the picked run interval, and marks the current one pressed", () => {
    const onRunWalkChange = vi.fn();
    render(<StylePicker value="runwalk" onChange={vi.fn()} runWalk={RUNWALK_DEFAULT} onRunWalkChange={onRunWalkChange}/>);
    // "1 min 30 s" appears once per column (run and walk) — the run row is first.
    fireEvent.click(screen.getAllByRole("button", { name: "1 min 30 s" })[0]);
    expect(onRunWalkChange).toHaveBeenCalledWith({ runSec: 90, walkSec: 60 });
    expect(screen.getAllByRole("button", { name: "3 min" })[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("still selects a style when the card carries the ratio control", () => {
    const onChange = vi.fn();
    render(<StylePicker value="runwalk" onChange={onChange} runWalk={RUNWALK_DEFAULT} onRunWalkChange={vi.fn()}/>);
    fireEvent.click(screen.getByText("Balanced"));
    expect(onChange).toHaveBeenCalledWith("balanced");
  });
});
