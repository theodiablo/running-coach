import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { GoalConfigurator } from "./GoalConfigurator";
import { clampGoalSec } from "../utils/goal";

afterEach(cleanup);

// iOS's number pad has no ":" key, so the goal fields must take a time from digits alone.
describe("GoalConfigurator typed goal", () => {
  const setup = (goalSec: number) => {
    const onChange = vi.fn();
    render(<GoalConfigurator distanceKm={21.1} goalSec={goalSec} onChange={onChange}/>);
    const [time, pace] = screen.getAllByRole("textbox") as HTMLInputElement[];
    return { onChange, time, pace };
  };
  const goal = clampGoalSec(2 * 3600, 21.1);

  it("reads a digits-only time right to left (14500 → 1:45:00)", () => {
    const { onChange, time } = setup(goal);
    expect(time.inputMode).toBe("numeric");
    fireEvent.change(time, { target: { value: "14500" } });
    expect(time.value).toBe("1:45:00");
    fireEvent.blur(time);
    expect(onChange).toHaveBeenLastCalledWith(clampGoalSec(6300, 21.1));
  });

  it("reads a digits-only pace per km (530 → 5:30/km)", () => {
    const { onChange, pace } = setup(goal);
    fireEvent.change(pace, { target: { value: "530" } });
    expect(pace.value).toBe("5:30");
    fireEvent.blur(pace);
    expect(onChange).toHaveBeenLastCalledWith(clampGoalSec(Math.round(330 * 21.1), 21.1));
  });

  it("reverts an emptied field instead of committing zero", () => {
    const { onChange, time } = setup(goal);
    onChange.mockClear();
    fireEvent.change(time, { target: { value: "" } });
    fireEvent.blur(time);
    expect(onChange).not.toHaveBeenCalled();
    expect(time.value).not.toBe("");
  });
});
