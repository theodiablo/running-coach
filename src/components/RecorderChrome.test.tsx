import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { HoldCtrl, HOLD_MS } from "./RecorderChrome";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); cleanup(); });

const setup = () => {
  const onHold = vi.fn();
  render(<HoldCtrl onHold={onHold} hint="Hold to finish" color="bg-red-500">Finish</HoldCtrl>);
  return { onHold, btn: screen.getByRole("button") };
};

const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe("HoldCtrl", () => {
  it("fires once the press has been held long enough", () => {
    const { onHold, btn } = setup();
    fireEvent.pointerDown(btn);
    wait(HOLD_MS - 1);
    expect(onHold).not.toHaveBeenCalled();
    wait(1);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["released early", (btn: HTMLElement) => fireEvent.pointerUp(btn)],
    ["cancelled by the platform", (btn: HTMLElement) => fireEvent.pointerCancel(btn)],
  ])("does nothing when %s, and says why", (_label, release) => {
    const { onHold, btn } = setup();
    fireEvent.pointerDown(btn);
    wait(HOLD_MS - 200);
    release(btn);
    wait(HOLD_MS);
    expect(onHold).not.toHaveBeenCalled();
    expect(btn).toHaveTextContent("Hold to finish");
  });

  // The web build is a browser app; Enter/Space must not be a dead button.
  it("holds from the keyboard", () => {
    const { onHold, btn } = setup();
    fireEvent.keyDown(btn, { key: "Enter" });
    wait(HOLD_MS);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("does not fire on a tap, which browsers also send as a click", () => {
    const { onHold, btn } = setup();
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);
    fireEvent.click(btn);
    wait(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it("drops a press the button loses focus mid-way through", () => {
    const { onHold, btn } = setup();
    fireEvent.keyDown(btn, { key: " " });
    fireEvent.blur(btn);
    wait(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });
});
