import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { PLAY_UPDATE_PROMPT_KEY } from "../constants";
import type { Run } from "../types";

vi.mock("../native", () => ({ isNative: true }));
const { bridge, track } = vi.hoisted(() => ({
  bridge: { requestStoreReview: vi.fn(), startPlayUpdate: vi.fn() },
  track: vi.fn(),
}));
vi.mock("../storeBridge", () => bridge);
vi.mock("../telemetry", () => ({ track }));

import { StorePrompts, STORE_PROMPT_DELAY_MS } from "./StorePrompts";

const TODAY = new Date("2026-06-30T10:00:00");
const daysAgo = (n: number) => {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const regular = [0, 3, 6, 12, 20, 30].map((n) => ({ date: daysAgo(n), type: "EASY", km: 5 }) as Run);
const playUpdate = { via: "play" as const, versionCode: 42, status: "unknown", progress: null };

const base = { calm: true, update: null, runs: regular, reviewAsks: undefined, reviewMoment: true };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TODAY);
  vi.clearAllMocks();
  bridge.requestStoreReview.mockResolvedValue(true);
  bridge.startPlayUpdate.mockResolvedValue("declined");
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(STORE_PROMPT_DELAY_MS); });

describe("StorePrompts", () => {
  it("asks for a review on a calm Home after a regular runner's run", async () => {
    const spent = vi.fn();
    render(<StorePrompts {...base} onMomentSpent={spent}/>);
    await settle();
    expect(bridge.requestStoreReview).toHaveBeenCalledOnce();
    expect(spent).toHaveBeenCalledWith({ reviewAsks: [daysAgo(0)] });
    expect(track).toHaveBeenCalledWith("review_requested", {});
  });

  it("waits while anything else is up", async () => {
    const spent = vi.fn();
    render(<StorePrompts {...base} calm={false} onMomentSpent={spent}/>);
    await settle();
    expect(bridge.requestStoreReview).not.toHaveBeenCalled();
    expect(spent).not.toHaveBeenCalled();
  });

  it("spends the moment without asking when the runner isn't there yet", async () => {
    const spent = vi.fn();
    render(<StorePrompts {...base} runs={regular.slice(0, 2)} onMomentSpent={spent}/>);
    await settle();
    expect(bridge.requestStoreReview).not.toHaveBeenCalled();
    expect(spent).toHaveBeenCalledWith(null);
  });

  it("offers Play's update once per version, and never alongside the review sheet", async () => {
    const spent = vi.fn();
    const { rerender } = render(<StorePrompts {...base} update={playUpdate} onMomentSpent={spent}/>);
    await settle();
    expect(bridge.startPlayUpdate).toHaveBeenCalledWith(false);
    expect(bridge.requestStoreReview).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(PLAY_UPDATE_PROMPT_KEY)!)).toMatchObject({ code: 42, asks: 1 });

    rerender(<StorePrompts {...base} update={playUpdate} calm={false} onMomentSpent={spent}/>);
    rerender(<StorePrompts {...base} update={playUpdate} onMomentSpent={spent}/>);
    await settle();
    expect(bridge.startPlayUpdate).toHaveBeenCalledOnce();
  });

  it("leaves a download Play already started alone", async () => {
    render(<StorePrompts {...base} reviewMoment={false} update={{ ...playUpdate, status: "downloading" }} onMomentSpent={vi.fn()}/>);
    await settle();
    expect(bridge.startPlayUpdate).not.toHaveBeenCalled();
  });
});
