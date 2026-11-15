import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReviewPromptState } from "../types";

const { bridge, track } = vi.hoisted(() => ({
  bridge: { openStoreReview: vi.fn(), requestStoreReview: vi.fn() },
  track: vi.fn(),
}));
vi.mock("../storeBridge", () => bridge);
vi.mock("../telemetry", () => ({ track }));

import { useReviewPrompt } from "./useReviewPrompt";

const card = { prompt: "card" as const, link: true };
const native = { prompt: "native" as const, link: true };

// A patch that applies to a local copy, like the hub's setSettings updater.
function store(initial?: ReviewPromptState) {
  const box = { state: initial };
  const patch = vi.fn((f: (s: ReviewPromptState | undefined) => ReviewPromptState | undefined) => { box.state = f(box.state); });
  return { box, patch };
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.openStoreReview.mockResolvedValue(true);
  bridge.requestStoreReview.mockResolvedValue(true);
});

describe("useReviewPrompt", () => {
  it("a fresh run arms the moment; spending it on Android shows the card", () => {
    const { patch } = store();
    const { result } = renderHook(() => useReviewPrompt(card, patch));
    act(() => result.current.armMoment());
    expect(result.current.moment).toBe(true);
    act(() => result.current.spendMoment(1));
    expect(result.current.moment).toBe(false);
    expect(result.current.card?.ask).toBe(1);
  });

  it("counts a showing once, however often Home remounts", () => {
    const { box, patch } = store();
    const { result } = renderHook(() => useReviewPrompt(card, patch));
    act(() => result.current.spendMoment(1));
    act(() => { result.current.card!.onSeen(); result.current.card!.onSeen(); });
    expect(box.state?.asks).toHaveLength(1);
    expect(track.mock.calls.filter(c => c[0] === "review_card_shown")).toEqual([["review_card_shown", { ask: 1 }]]);
  });

  it("'Don't ask again' ends it and keeps the asks", () => {
    const { box, patch } = store({ asks: ["2026-01-01"] });
    const { result } = renderHook(() => useReviewPrompt(card, patch));
    act(() => result.current.spendMoment(2));
    act(() => result.current.card!.onAnswer("never"));
    expect(box.state).toEqual({ asks: ["2026-01-01"], done: "never" });
    expect(result.current.card).toBeNull();
    expect(track).toHaveBeenCalledWith("review_card_answered", { answer: "never", ask: 2 });
  });

  it("'Leave a review' ends it only once the store page opened", async () => {
    const { box, patch } = store();
    const { result } = renderHook(() => useReviewPrompt(card, patch));
    bridge.openStoreReview.mockResolvedValueOnce(false);
    act(() => result.current.spendMoment(1));
    await act(async () => { result.current.card!.onAnswer("review"); });
    expect(box.state?.done).toBeUndefined();
    act(() => result.current.spendMoment(2));
    await act(async () => { result.current.card!.onAnswer("review"); });
    expect(box.state?.done).toBe("review");
  });

  it("'Not now' leaves it open for a later ask", () => {
    const { box, patch } = store();
    const { result } = renderHook(() => useReviewPrompt(card, patch));
    act(() => result.current.spendMoment(1));
    act(() => result.current.card!.onAnswer("later"));
    expect(box.state?.done).toBeUndefined();
  });

  it("iOS: Apple's sheet, the ask recorded, no card", async () => {
    const { box, patch } = store();
    const { result } = renderHook(() => useReviewPrompt(native, patch));
    await act(async () => { result.current.spendMoment(1); });
    expect(result.current.card).toBeNull();
    expect(bridge.requestStoreReview).toHaveBeenCalledOnce();
    expect(box.state?.asks).toHaveLength(1);
    expect(track).toHaveBeenCalledWith("review_requested", { ask: 1 });
  });

  it("a review written from Settings ends the Home asks", async () => {
    const { box, patch } = store();
    const { result } = renderHook(() => useReviewPrompt(card, patch));
    await act(async () => { result.current.rateFromSettings(); });
    expect(box.state?.done).toBe("review");
  });

  it("a spent moment with nothing due shows nothing", () => {
    const { patch } = store();
    const { result } = renderHook(() => useReviewPrompt(card, patch));
    act(() => result.current.armMoment());
    act(() => result.current.spendMoment(null));
    expect(result.current.moment).toBe(false);
    expect(result.current.card).toBeNull();
    expect(patch).not.toHaveBeenCalled();
  });
});
