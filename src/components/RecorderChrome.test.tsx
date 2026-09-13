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

  // A tap sends pointerdown/up AND a click; only the assistive-tech click
  // (detail 0, no pointer behind it) may stand in for the hold.
  it("does not fire on a tap, whose click carries a pointer behind it", () => {
    const { onHold, btn } = setup();
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);
    fireEvent.click(btn, { detail: 1 });
    wait(HOLD_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  // Without this the button is inert to a screen reader, leaving the header's
  // discard as the only way out of a recording.
  it("fires on an assistive-tech activation, which has no press to hold", () => {
    const { onHold, btn } = setup();
    fireEvent.click(btn, { detail: 0 });
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("reads the callback as it is at fire time, not at press time", () => {
    const first = vi.fn(), second = vi.fn();
    const { rerender } = render(<HoldCtrl onHold={first} hint="Hold to finish" color="bg-red-500">Finish</HoldCtrl>);
    fireEvent.pointerDown(screen.getByRole("button"));
    wait(HOLD_MS - 500);
    rerender(<HoldCtrl onHold={second} hint="Hold to finish" color="bg-red-500">Finish</HoldCtrl>);
    wait(500);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("fires nothing if the screen unmounts mid-press", () => {
    const { onHold, btn } = setup();
    fireEvent.pointerDown(btn);
    wait(HOLD_MS - 100);
    cleanup();
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
