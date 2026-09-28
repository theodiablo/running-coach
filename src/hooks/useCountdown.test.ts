// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCountdown } from "./useCountdown";

// useCountdown runs N..1..0(Go)..done exactly once, driven by a single timer that
// clears on cancel/unmount so it can't double-fire.

describe("useCountdown", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("counts 3→2→1→Go then fires onDone once", () => {
    const onDone = vi.fn();
    const { result } = renderHook(() => useCountdown(onDone, 1000));
    expect(result.current.count).toBe(null);
    act(() => result.current.start(3));
    expect(result.current.count).toBe(3);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.count).toBe(2);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.count).toBe(1);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.count).toBe(0); // "Go!" frame
    expect(onDone).not.toHaveBeenCalled();
    // Go frame holds half a step, then hands off.
    act(() => { vi.advanceTimersByTime(500); });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(result.current.count).toBe(null);
  });

  it("cancel stops the countdown without firing onDone", () => {
    const onDone = vi.fn();
    const { result } = renderHook(() => useCountdown(onDone, 1000));
    act(() => result.current.start(3));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.count).toBe(2);
    act(() => result.current.cancel());
    expect(result.current.count).toBe(null);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onDone).not.toHaveBeenCalled();
  });

  it("does not fire onDone after unmount", () => {
    const onDone = vi.fn();
    const { result, unmount } = renderHook(() => useCountdown(onDone, 1000));
    act(() => result.current.start(1));
    act(() => { vi.advanceTimersByTime(1000); }); // → 0 (Go)
    unmount();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onDone).not.toHaveBeenCalled();
  });
});
