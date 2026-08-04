import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import PublicWatch from "./PublicWatch";
import type { WatchResult } from "../live/shareLink";

// The public watch page is the one surface a stranger sees, and it has two jobs
// it must not get wrong: say the SAME thing for every kind of "no run here" (so
// walking URLs teaches a crawler nothing), and never let a network failure read
// as a run that ended.

const fetchLiveWatch = vi.hoisted(() => vi.fn<() => Promise<WatchResult>>());
vi.mock("../live/shareLink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../live/shareLink")>()),
  fetchLiveWatch,
}));
// Leaflet needs a real layout box; the map itself is not what's under test.
vi.mock("../components/RouteMap", () => ({ RouteMap: () => <div data-testid="route-map" /> }));

const TOKEN = "a".repeat(22);
const run = (over: Partial<{ status: string; updated_at: string }> = {}) => ({
  status: "live", started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  points: [[1, 2, Date.now(), null]], stats: { km: 3.2, durationSec: 900, avgPace: 280 },
  ...over,
} as never);

beforeEach(() => {
  fetchLiveWatch.mockReset();
  document.head.querySelectorAll('meta[name="robots"], meta[name="referrer"]').forEach(el => el.remove());
});
afterEach(() => vi.useRealTimers());

describe("PublicWatch", () => {
  it("shows the run once it resolves, with no hint of whose it is", async () => {
    fetchLiveWatch.mockResolvedValue({ kind: "live", run: run() });
    render(<PublicWatch token={TOKEN} />);

    expect(await screen.findByTestId("route-map")).toBeInTheDocument();
    expect(screen.getByText("3.20")).toBeInTheDocument();
    // Nothing identifying: the edge function never returns the account id, and
    // the page never asks who the runner is.
    expect(document.body.textContent).not.toMatch(/@|user_id/i);
  });

  it("gives one answer for every flavour of 'nothing here'", async () => {
    // A bad token, a run that hasn't started and a swept row all arrive as
    // { kind: "none" } — the page must not add a distinction of its own.
    fetchLiveWatch.mockResolvedValue({ kind: "none" });
    render(<PublicWatch token={TOKEN} />);
    expect(await screen.findByText(/Nothing live here right now/i)).toBeInTheDocument();
    // ...and it explains the legitimate case rather than reading as an error.
    expect(screen.getByText(/keep this page open/i)).toBeInTheDocument();
    expect(screen.queryByTestId("route-map")).toBeNull();
  });

  it("keeps the run on screen when the connection drops", async () => {
    // The one lie this page could tell: rendering a dropped connection as a
    // finished run.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchLiveWatch.mockResolvedValueOnce({ kind: "live", run: run() });
    render(<PublicWatch token={TOKEN} />);
    expect(await screen.findByTestId("route-map")).toBeInTheDocument();

    fetchLiveWatch.mockResolvedValue({ kind: "error" });
    await act(async () => { await vi.advanceTimersByTimeAsync(31000); });
    expect(screen.getByTestId("route-map")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing live here/i)).toBeNull();
  });

  it("polls at the publisher's cadence while a run is live", async () => {
    // Reading faster than the phone writes can only return what we already have.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchLiveWatch.mockResolvedValue({ kind: "live", run: run() });
    render(<PublicWatch token={TOKEN} />);
    await waitFor(() => expect(fetchLiveWatch).toHaveBeenCalledTimes(1));

    await act(async () => { await vi.advanceTimersByTimeAsync(29000); });
    expect(fetchLiveWatch).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(fetchLiveWatch).toHaveBeenCalledTimes(2);
  });

  it("backs off while nothing is live, and stops polling once unmounted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchLiveWatch.mockResolvedValue({ kind: "none" });
    const { unmount } = render(<PublicWatch token={TOKEN} />);
    await waitFor(() => expect(fetchLiveWatch).toHaveBeenCalledTimes(1));

    await act(async () => { await vi.advanceTimersByTimeAsync(31000); });
    expect(fetchLiveWatch).toHaveBeenCalledTimes(1); // idle cadence, not 30s
    await act(async () => { await vi.advanceTimersByTimeAsync(31000); });
    expect(fetchLiveWatch).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
    expect(fetchLiveWatch).toHaveBeenCalledTimes(2);
  });

  it("keeps itself out of search results while it is up", async () => {
    // A link pasted into a public thread must not get indexed and then crawled;
    // no-referrer keeps the token out of any outbound Referer header.
    fetchLiveWatch.mockResolvedValue({ kind: "none" });
    const { unmount } = render(<PublicWatch token={TOKEN} />);
    await screen.findByText(/Nothing live here right now/i);

    expect(document.querySelector('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
    expect(document.querySelector('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");

    unmount();
    expect(document.querySelector('meta[name="referrer"]')).toBeNull();
  });

  it("offers a way into the app without needing one to watch", async () => {
    fetchLiveWatch.mockResolvedValue({ kind: "none" });
    render(<PublicWatch token={TOKEN} />);
    await screen.findByText(/Nothing live here right now/i);
    // Same page whether or not the viewer is signed in: the token authorizes the
    // view, the session authorizes nothing here.
    expect(screen.getAllByRole("link").every(a => a.getAttribute("href") === "/")).toBe(true);
  });
});
