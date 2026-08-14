import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

// The indoor recorder over the real useRunTracker, with only the two device
// seams faked: the BLE heart-rate source (driven by hand) and the route store
// (so a save doesn't need Supabase). Geolocation is deliberately NOT mocked
// away — the point of the screen is that it never asks for it.

const hr = vi.hoisted(() => {
  type Sample = { bpm: number; t: number };
  type Watch = { onSample: (s: Sample) => void; stopped: boolean };
  const watches: Watch[] = [];
  const source = {
    id: "bluetooth",
    live: true,
    watch: vi.fn((onSample: (s: Sample) => void) => {
      const handle = { onSample, stopped: false };
      watches.push(handle);
      return handle;
    }),
    clearWatch: vi.fn((h: Watch | null) => { if (h) h.stopped = true; }),
  };
  return { watches, source };
});

// A post-run source (Health Connect / Apple Health): no live stream, HR is
// fetched over the session's window once it ends.
const post = vi.hoisted(() => ({
  id: "healthconnect",
  live: false as const,
  fetchRange: vi.fn(async () => ({ hrAvg: 0, hrMax: 0 }) as { hrAvg?: number; hrMax?: number }),
}));

const routes = vi.hoisted(() => ({ saveRoute: vi.fn(async () => "route-1"), queuePendingRoute: vi.fn() }));
const geo = vi.hoisted(() => ({
  isAvailable: vi.fn(() => true),
  checkPermissions: vi.fn(async () => true),
  requestPermissions: vi.fn(async () => true),
  watchPosition: vi.fn(() => ({ id: "w0", removed: false })),
  clearWatch: vi.fn(),
}));

vi.mock("../geo/source", () => ({ geoSource: geo }));
vi.mock("../hr/source", () => ({
  getHrSource: (m: string) => (m === "bluetooth" ? hr.source : m === "healthconnect" ? post : null),
}));
vi.mock("../hr/device", () => ({ getPairedDevice: () => ({ id: "strap-1" }), setPairedDevice: vi.fn() }));
vi.mock("../hr/healthconnect", () => ({ hasHealthConnectAuthorization: () => false }));
vi.mock("../healthkit/import", () => ({ hasHealthKitAuthorization: () => false }));
vi.mock("../native", () => ({ isNative: false, isAndroid: false, isIos: false, platform: "web" }));
vi.mock("../routes", () => routes);
// Skip the 3-2-1 overlay so Start is synchronous and the wall clock below stays
// exact. The countdown itself is covered by useCountdown's own tests.
vi.mock("../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));

import { IndoorTracker } from "./IndoorTracker";
import { INDOOR_RUN_KEY } from "../constants";
import type { Run, SettingsState } from "../types";

const START = 1_700_000_000_000;
const settings = { maxHR: 200, restHR: 60 } as unknown as SettingsState;

const show = (onFinish: (r: Partial<Run>) => void = () => {}) =>
  render(<IndoorTracker settings={settings} hrMethod="bluetooth"
    onFinish={onFinish} onClose={() => {}} />);

beforeEach(() => {
  localStorage.clear();
  hr.watches.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

const start = () => act(() => { fireEvent.click(screen.getByRole("button", { name: /start session/i })); });
const finish = () => act(() => { fireEvent.click(screen.getByRole("button", { name: /finish/i })); });

describe("IndoorTracker", () => {
  it("never asks for a position, before or during a session", () => {
    show();
    start();
    expect(geo.watchPosition).not.toHaveBeenCalled();
    expect(geo.requestPermissions).not.toHaveBeenCalled();
  });

  // The strap is watched from idle, so the runner can see where they are before
  // committing — and, on this screen, whether that is the zone being asked for.
  it("shows the live reading and its zone before the session starts", () => {
    show();
    act(() => hr.watches[0].onSample({ bpm: 180, t: START }));
    expect(screen.getByText("180")).toBeInTheDocument();
    expect(screen.getByText(/threshold/i)).toBeInTheDocument();     // where they are
    expect(screen.getByText(/144.*158 bpm/)).toBeInTheDocument();   // the Z2 target
  });

  // A strap notifying across the whole session: 30 samples a minute apart,
  // alternating 140/160, so the mean is exactly 150 and coverage is ~97%.
  const streamFullSession = () => {
    for (let i = 0; i < 30; i++) {
      act(() => hr.watches[0].onSample({ bpm: i % 2 ? 160 : 140, t: START + i * 60_000 }));
    }
  };

  it("saves duration and heart rate with no distance at all", async () => {
    const onFinish = vi.fn();
    show(onFinish);
    start();
    streamFullSession();
    vi.setSystemTime(START + 1_800_000); // 30 min
    finish();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /save session/i })); });

    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.calls[0][0]).toMatchObject({
      type: "OTHER",
      km: 0,
      durationSec: 1800,
      source: "indoor",
      activity: "bike",
      hr: 150,
      hrMax: 160,
      // Stamped empty on purpose: "measured, covers no standard distance", which
      // is what keeps the one-time best-effort backfill off this run.
      bestEfforts: {},
      // The raw stream rides the HR-only sidecar, never routeId — History must
      // not offer a map button for a session that has no route.
      hrRouteId: "route-1",
    });
    expect(onFinish.mock.calls[0][0].routeId).toBeUndefined();
    expect(routes.saveRoute).toHaveBeenCalledWith(
      expect.objectContaining({ points: [], stats: expect.objectContaining({ km: 0 }) }));
  });

  // On this screen heart rate IS the session, so a strap that dropped after two
  // minutes must not have its fragment's mean stamped on the whole thing.
  it("withholds heart rate when the strap only covered part of the session", async () => {
    const onFinish = vi.fn();
    const toast = vi.fn();
    render(<IndoorTracker settings={settings} hrMethod="bluetooth" showToast={toast}
      onFinish={onFinish} onClose={() => {}} />);
    start();
    act(() => hr.watches[0].onSample({ bpm: 120, t: START }));
    act(() => hr.watches[0].onSample({ bpm: 122, t: START + 60_000 }));
    vi.setSystemTime(START + 1_800_000);
    finish();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /save session/i })); });

    const saved = onFinish.mock.calls[0][0];
    expect(saved.hr).toBeUndefined();
    expect(saved.hrMax).toBeUndefined();
    // The samples still save (the detail chart draws them) and the run records
    // how much was actually measured.
    expect(saved.hrRouteId).toBe("route-1");
    expect(saved.hrCoverage).toBeCloseTo(0.03, 2);   // 60s of 1800s
    expect(toast).toHaveBeenCalled();
  });

  it("stamps full coverage when the strap ran the whole session", async () => {
    const onFinish = vi.fn();
    show(onFinish);
    start();
    streamFullSession();
    vi.setSystemTime(START + 1_800_000);
    finish();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /save session/i })); });
    expect(onFinish.mock.calls[0][0].hrCoverage).toBeCloseTo(0.97, 2);
  });

  it("records the machine the session was done on", async () => {
    const onFinish = vi.fn();
    show(onFinish);
    fireEvent.click(screen.getByRole("button", { name: /elliptical/i }));
    start();
    vi.setSystemTime(START + 600_000);
    finish();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /save session/i })); });
    expect(onFinish.mock.calls[0][0].activity).toBe("elliptical");
  });

  // The screen tells Health Connect / Apple Health users "heart rate is added
  // after you finish". These two are that promise being kept.
  describe("post-run heart-rate source", () => {
    const showPostRun = (onFinish: (r: Partial<Run>) => void) =>
      render(<IndoorTracker settings={settings} hrMethod="healthconnect"
        onFinish={onFinish} onClose={() => {}} />);

    const record = async (onFinish: ReturnType<typeof vi.fn>) => {
      start();
      vi.setSystemTime(START + 1_800_000);
      finish();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: /save session/i })); });
      return onFinish.mock.calls[0][0];
    };

    it("fetches heart rate over the session window once it ends", async () => {
      post.fetchRange.mockResolvedValueOnce({ hrAvg: 138, hrMax: 161 });
      const onFinish = vi.fn();
      showPostRun(onFinish);
      const saved = await record(onFinish);

      expect(post.fetchRange).toHaveBeenCalledWith(START, START + 1_800_000);
      expect(saved).toMatchObject({ hr: 138, hrMax: 161 });
      expect(saved.hrPending).toBeUndefined();
    });

    it("stamps a pending marker when the store hasn't synced yet, so it relinks later", async () => {
      post.fetchRange.mockResolvedValueOnce({});
      const onFinish = vi.fn();
      showPostRun(onFinish);
      const saved = await record(onFinish);

      expect(saved.hr).toBeUndefined();
      expect(saved.hrPending).toEqual({ start: START, end: START + 1_800_000, source: "healthconnect" });
    });

    it("survives a throwing store rather than losing the session", async () => {
      post.fetchRange.mockRejectedValueOnce(new Error("not authorized"));
      const onFinish = vi.fn();
      showPostRun(onFinish);
      const saved = await record(onFinish);

      expect(saved).toMatchObject({ type: "OTHER", durationSec: 1800 });
      expect(saved.hrPending).toMatchObject({ source: "healthconnect" });
    });
  });

  // A window.confirm raised as the activity backgrounds never answers, and it
  // holds the JS thread — which froze the recorder mid-session with the clock
  // stopped and every control dead. The confirm has to live in the DOM.
  describe("discarding an in-progress session", () => {
    it("asks in the DOM, never through window.confirm", () => {
      const confirmSpy = vi.spyOn(window, "confirm");
      const onClose = vi.fn();
      render(<IndoorTracker settings={settings} hrMethod="bluetooth"
        onFinish={() => {}} onClose={onClose} />);
      start();
      act(() => { vi.advanceTimersByTime(60_000); }); // real ticks, so the clock advances
      act(() => { fireEvent.click(screen.getByRole("button", { name: /close/i })); });

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(screen.getByText(/discard this session/i)).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it("keeps recording when the discard is cancelled", () => {
      const onClose = vi.fn();
      render(<IndoorTracker settings={settings} hrMethod="bluetooth"
        onFinish={() => {}} onClose={onClose} />);
      start();
      act(() => { vi.advanceTimersByTime(60_000); }); // real ticks, so the clock advances
      act(() => { fireEvent.click(screen.getByRole("button", { name: /close/i })); });
      act(() => { fireEvent.click(screen.getByRole("button", { name: /^cancel$/i })); });

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.queryByText(/discard this session/i)).not.toBeInTheDocument();
      // Still live: the clock kept its elapsed time and Finish is still offered.
      expect(screen.getByRole("button", { name: /finish/i })).toBeInTheDocument();
      expect(screen.getByText("1:00")).toBeInTheDocument();
    });

    it("closes and clears the buffer once the discard is confirmed", () => {
      const onClose = vi.fn();
      render(<IndoorTracker settings={settings} hrMethod="bluetooth"
        onFinish={() => {}} onClose={onClose} />);
      start();
      act(() => { vi.advanceTimersByTime(60_000); }); // real ticks, so the clock advances
      act(() => { fireEvent.click(screen.getByRole("button", { name: /close/i })); });
      act(() => { fireEvent.click(screen.getByRole("button", { name: /^discard$/i })); });

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(INDOOR_RUN_KEY)).toBeNull();
    });

    it("closes straight away when there is nothing to lose", () => {
      const onClose = vi.fn();
      render(<IndoorTracker settings={settings} hrMethod="bluetooth"
        onFinish={() => {}} onClose={onClose} />);
      act(() => { fireEvent.click(screen.getByRole("button", { name: /close/i })); });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("saves a session recorded without a sensor rather than blocking on HR", async () => {
    const onFinish = vi.fn();
    render(<IndoorTracker settings={settings} hrMethod="off" onFinish={onFinish} onClose={() => {}} />);
    start();
    vi.setSystemTime(START + 600_000);
    finish();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /save session/i })); });
    const saved = onFinish.mock.calls[0][0];
    expect(saved).toMatchObject({ type: "OTHER", km: 0, durationSec: 600 });
    // No sensor, no invented numbers.
    expect(saved.hr).toBeUndefined();
    expect(saved.hrMax).toBeUndefined();
  });
});
