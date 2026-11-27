import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { RunCelebration } from "./RunCelebration";
import type { Celebration } from "../utils/runCelebration";
import type { EffortRank } from "../utils/bestEfforts";
import type { Run } from "../types";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const run: Run = { date: "2026-09-16", km: 10.2, durationSec: 3060 };
const base: Celebration = {
  headline: "celebration.head.run.r1",
  fact: { key: "celebration.fact.longest.a", vars: { km: "10.2" }, weight: 3 },
  efforts: [], confetti: false, rare: false, badge: null,
};
const pb: EffortRank = { key: "5k", km: 5, sec: 1400, rank: 1, total: 4, estimated: false,
  previousBest: { sec: 1450, date: "2026-06-01" }, gainSec: 50 };

const show = (c: Partial<Celebration> = {}, onClose = vi.fn(), r: Run = run) => {
  render(<RunCelebration celebration={{ ...base, ...c }} run={r} onClose={onClose} />);
  return onClose;
};

const badge = { id: "vol-100", Icon: "Gauge" as const, unlocked: true, label: "Century", desc: "", progress: 1, hint: null };

describe("RunCelebration · badges", () => {
  it("celebrates a badge the run unlocked and waits for a tap", () => {
    const onClose = show({ badge: { kind: "unlocked", badge, more: 1 } });
    expect(screen.getByText("Badge unlocked")).toBeInTheDocument();
    expect(screen.getByText("Century")).toBeInTheDocument();
    expect(screen.getByText("and 1 more")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(6000); });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says how much closer the run brought the next badge", () => {
    show({ badge: { kind: "closer", badge: { ...badge, unlocked: false, progress: 0.86, hint: "14 km to go" } } });
    expect(screen.getByText("Closer to Century: 14 km to go")).toBeInTheDocument();
  });
});

describe("RunCelebration", () => {
  it("shows the headline, the run's own fact and its numbers", () => {
    show();
    expect(screen.getByText("Way to go!")).toBeInTheDocument();
    expect(screen.getByText("10.2 km: your longest run yet")).toBeInTheDocument();
    expect(screen.getByText(/10\.2 km · 51:00 · 5:00\/km/)).toBeInTheDocument();
  });

  it("moves on to the summary by itself", () => {
    const onClose = show();
    act(() => { vi.advanceTimersByTime(3900); });
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(200); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores the release of the Finish hold, then closes on a tap", () => {
    const onClose = show();
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("waits for the runner when there are best efforts to read", () => {
    const onClose = show({ headline: "celebration.head.pb.p6", efforts: [pb] });
    expect(screen.getByText("Fastest ever")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(10000); });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says when the line is a rare one", () => {
    show({ headline: "celebration.head.rare.x1", rare: true });
    expect(screen.getByText("You're a superstar!")).toBeInTheDocument();
    expect(screen.getByText(/1 in 100/)).toBeInTheDocument();
  });

  it("shows only the time for an indoor session", () => {
    show({ headline: "celebration.head.indoor.i1", fact: null }, vi.fn(), { date: "2026-09-16", km: 0, durationSec: 2400, type: "OTHER" });
    expect(screen.getByText("40:00")).toBeInTheDocument();
    expect(screen.queryByText(/km/)).not.toBeInTheDocument();
  });
});

vi.mock("./ShareCardGate", () => ({
  ShareCardGate: ({ onClose }: { onClose: () => void }) => <div role="dialog" aria-label="share builder"><button onClick={onClose}>close builder</button></div>,
}));

describe("RunCelebration · share", () => {
  const share = { runs: [], plan: null, settings: {} as never, participations: [], points: null };

  it("offers no share action without the share data", () => {
    show();
    expect(screen.queryByRole("button", { name: "Share this run" })).toBeNull();
  });

  it("opens the builder without closing, and stops the auto-close", () => {
    const onClose = vi.fn();
    render(<RunCelebration celebration={base} run={run} onClose={onClose} share={share} />);
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.click(screen.getByRole("button", { name: "Share this run" }));
    expect(screen.getByRole("dialog", { name: "share builder" })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(onClose).not.toHaveBeenCalled();
    // Back from the builder, the screen waits on Continue.
    fireEvent.click(screen.getByRole("button", { name: "close builder" }));
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
