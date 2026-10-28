import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import PublicWatch from "./PublicWatch";
import type { BatchRequestEntry, BatchResult } from "../live/shareLink";
import { FOLLOW_KEY, followRunner } from "../live/followList";

// `/watch/`: everyone this browser follows, from one batched read. It must ask
// for a full trace only where one is needed, keep a finished run on screen the
// way the single page does, and never turn a failed read into "not live".

const fetchLiveWatchBatch = vi.hoisted(() => vi.fn<(e: BatchRequestEntry[]) => Promise<BatchResult>>());
vi.mock("../live/shareLink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../live/shareLink")>()),
  fetchLiveWatchBatch,
}));
const mapProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock("./MultiRunnerMap", () => ({
  MultiRunnerMap: (p: Record<string, unknown>) => { mapProps.current = p; return <div data-testid="multi-map" />; },
}));
vi.mock("../components/RouteMap", () => ({ RouteMap: () => <div data-testid="route-map" /> }));

const A = "a".repeat(22), B = "b".repeat(22);
const now = () => new Date().toISOString();
const summary = (over: Record<string, unknown> = {}) => ({
  kind: "summary" as const,
  run: { status: "live", started_at: "s1", updated_at: now(), stats: { km: 7.4, durationSec: 2100, avgPace: 284 }, head: [43.3, -1.9, 1, null], ...over } as never,
});
const full = (over: Record<string, unknown> = {}) => ({
  kind: "full" as const,
  run: { status: "live", started_at: "s1", updated_at: now(), stats: { km: 7.4, durationSec: 2100, avgPace: 284 }, points: [[43.2, -1.9, 0, null], [43.3, -1.9, 1, null]], ...over } as never,
});

beforeEach(() => {
  localStorage.clear();
  fetchLiveWatchBatch.mockReset();
  mapProps.current = null;
});

describe("MultiWatch", () => {
  it("offers a way in when this browser follows nobody, without writing anything", async () => {
    render(<PublicWatch token={null} />);
    expect(await screen.findByText(/don't follow anyone in this browser/i)).toBeInTheDocument();
    expect(fetchLiveWatchBatch).not.toHaveBeenCalled();
    expect(localStorage.getItem(FOLLOW_KEY)).toBeNull();
  });

  it("reads everyone in one batch, heads only until a runner is tapped", async () => {
    followRunner(A, "Marie");
    followRunner(B, "Iñaki");
    fetchLiveWatchBatch.mockResolvedValue({ kind: "ok", results: [summary(), { kind: "none" }] });
    render(<PublicWatch token={null} />);

    expect(await screen.findByText("2 following · 1 live")).toBeInTheDocument();
    expect(fetchLiveWatchBatch.mock.calls[0][0]).toEqual([
      { token: A, full: false, since: null }, { token: B, full: false, since: null },
    ]);
    expect(screen.getByText("Not live")).toBeInTheDocument();
    expect((mapProps.current?.track as unknown) ?? null).toBeNull();

    fetchLiveWatchBatch.mockResolvedValue({ kind: "ok", results: [full(), { kind: "none" }] });
    fireEvent.click(screen.getByRole("button", { name: /Marie/ }));
    await waitFor(() => expect(fetchLiveWatchBatch).toHaveBeenCalledTimes(2));
    expect(fetchLiveWatchBatch.mock.calls[1][0][0]).toEqual({ token: A, full: true, since: null });
    await waitFor(() => expect(mapProps.current?.track).toHaveLength(2));
    expect(screen.getByText("7.40")).toBeInTheDocument();
  });

  it("keeps a finished run after its row is swept, and never blanks on a failed read", async () => {
    followRunner(A, "Léa");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchLiveWatchBatch.mockResolvedValueOnce({ kind: "ok", results: [full({ status: "ended" })] });
      render(<PublicWatch token={null} />);
      expect(await screen.findByText("Finished")).toBeInTheDocument();

      // The runner saves: the row is gone. Hold the finished run.
      fetchLiveWatchBatch.mockResolvedValueOnce({ kind: "ok", results: [{ kind: "none" }] });
      await act(async () => { await vi.advanceTimersByTimeAsync(61000); });
      expect(screen.getByText("Finished")).toBeInTheDocument();

      fetchLiveWatchBatch.mockResolvedValueOnce({ kind: "error" });
      await act(async () => { await vi.advanceTimersByTimeAsync(61000); });
      expect(screen.getByText("Finished")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the trace it holds as `since`, so an unchanged one costs nothing", async () => {
    followRunner(A, "Marie");
    const f = full();
    fetchLiveWatchBatch.mockResolvedValue({ kind: "ok", results: [summary()] });
    render(<PublicWatch token={null} />);
    await screen.findByText("Marie");
    fetchLiveWatchBatch.mockResolvedValueOnce({ kind: "ok", results: [f] });
    fireEvent.click(screen.getByRole("button", { name: /Marie/ }));
    await waitFor(() => expect(mapProps.current?.track).toHaveLength(2));
    fetchLiveWatchBatch.mockResolvedValue({ kind: "ok", results: [{ kind: "unchanged" }] });
    fireEvent.click(screen.getByRole("button", { name: "Everyone" }));
    fireEvent.click(screen.getByRole("button", { name: /Marie/ }));
    await waitFor(() => expect(fetchLiveWatchBatch.mock.calls.at(-1)?.[0][0]).toEqual({ token: A, full: true, since: (f.run as { updated_at: string }).updated_at }));
    expect(mapProps.current?.track).toHaveLength(2);
  });

  it("adds a pasted link only once named, and removes a runner after a confirm on the page", async () => {
    followRunner(A, "Marie");
    fetchLiveWatchBatch.mockResolvedValue({ kind: "ok", results: [summary()] });
    render(<PublicWatch token={null} />);
    await screen.findByText("Marie");

    fireEvent.change(screen.getByLabelText("Add a runner"), { target: { value: "not a link" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/isn't a live-run link/);

    fireEvent.change(screen.getByLabelText("Add a runner"), { target: { value: `https://example.com/watch/${B}` } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(JSON.parse(localStorage.getItem(FOLLOW_KEY)!).runners).toHaveLength(1);
    fireEvent.change(await screen.findByLabelText("Who is this?"), { target: { value: "Iñaki" } });
    fireEvent.click(screen.getByRole("button", { name: "Follow" }));
    // Added and focused straight away.
    expect(await screen.findByRole("button", { name: /Iñaki/, pressed: true })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(FOLLOW_KEY)!).runners).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(within(screen.getByRole("group")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Iñaki/ })).toBeNull());
    expect(JSON.parse(localStorage.getItem(FOLLOW_KEY)!).runners.map((r: { name: string }) => r.name)).toEqual(["Marie"]);
  });
});

