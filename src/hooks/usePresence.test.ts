// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePresence } from "./usePresence";

// usePresence keeps a value mounted for `exitMs` after it goes null so an exit
// animation can play, then clears it — while cancelling that tail if a new value
// arrives first.

describe("usePresence", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("passes a non-null value straight through", () => {
    const { result } = renderHook(({ v }) => usePresence(v, 200), {
      initialProps: { v: "a" as string | null },
    });
    expect(result.current.rendered).toBe("a");
    expect(result.current.closing).toBe(false);
  });

  it("holds the value for exitMs after it goes null, then clears", () => {
    const { result, rerender } = renderHook(({ v }) => usePresence(v, 200), {
      initialProps: { v: "a" as string | null },
    });
    rerender({ v: null });
    // Still rendered, now marked closing.
    expect(result.current.rendered).toBe("a");
    expect(result.current.closing).toBe(true);
    // Not yet cleared just before the tail elapses.
    act(() => { vi.advanceTimersByTime(199); });
    expect(result.current.rendered).toBe("a");
    // Cleared once the tail elapses.
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.rendered).toBe(null);
    expect(result.current.closing).toBe(false);
  });

  it("cancels the close and swaps content when a new value arrives mid-tail", () => {
    const { result, rerender } = renderHook(({ v }) => usePresence(v, 200), {
      initialProps: { v: "a" as string | null },
    });
    rerender({ v: null });
    expect(result.current.closing).toBe(true);
    act(() => { vi.advanceTimersByTime(100); });
    rerender({ v: "b" });
    // Immediately shows the new value, no longer closing.
    expect(result.current.rendered).toBe("b");
    expect(result.current.closing).toBe(false);
    // The original close timer must not fire and blank "b".
    act(() => { vi.advanceTimersByTime(300); });
    expect(result.current.rendered).toBe("b");
  });
});
