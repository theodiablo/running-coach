import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { INDOOR_RUN_KEY, LIVE_RUN_KEY } from "../constants";
import { normalizeRecovery } from "../utils/runRecovery";

// useRunTracker is the single GPS funnel: the start/pause/resume/stop/reset state
// machine, moving-time accounting, the onPos jitter/interval/gap/warm-up filter,
// and the localStorage recovery buffer. It talks to geolocation only through
// geoSource, so we mock that and drive its captured onPos callback directly —
// exercising the real hook logic without a browser Geolocation API.

// Shared mock state, hoisted so the vi.mock factories below can close over it.
const h = vi.hoisted(() => {
  type Watcher = {
    onPos: (p: unknown) => void;
    onErr?: (e: unknown) => void;
    background: boolean;
    handle: { id: string; removed: boolean };
  };
  const watchers: Watcher[] = [];
  let seq = 0;
  const geoSource = {
    isAvailable: vi.fn(() => true),
    checkPermissions: vi.fn(async () => false),
    requestPermissions: vi.fn(async () => true),
    watchPosition: vi.fn((onPos: (p: unknown) => void, onErr?: (e: unknown) => void, opts?: { background?: boolean }) => {
      const handle = { id: `w${seq++}`, removed: false };
      watchers.push({ onPos, onErr, background: !!opts?.background, handle });
      return handle;
    }),
    clearWatch: vi.fn((handle: { removed: boolean } | null | undefined) => { if (handle) handle.removed = true; }),
  };
  return { watchers, geoSource };
});

// Same treatment for the live heart-rate seam: a fake Bluetooth-style source
// whose watch handle we drive by hand. `enabled`/`device` are flipped per test
// (default off, so every GPS test above behaves as if HR were off).
const hr = vi.hoisted(() => {
  type HrSample = { bpm: number; t: number };
  type HrWatchOpts = {
    deviceId?: string; deviceName?: string;
    onDeviceChange?: (d: { id: string; name: string }) => void;
    onStatus?: (s: string) => void;
  };
  type HrWatch = { onSample: (s: HrSample) => void; opts: HrWatchOpts; stopped: boolean };
  const watches: HrWatch[] = [];
  const source = {
    id: "bluetooth",
    live: true,
    watch: vi.fn((onSample: (s: HrSample) => void, _onErr?: unknown, opts: HrWatchOpts = {}) => {
      const handle = { onSample, opts, stopped: false };
      watches.push(handle);
      return handle;
    }),
    clearWatch: vi.fn((handle: HrWatch | null | undefined) => { if (handle) handle.stopped = true; }),
  };
  // The native HR journal seam. Real calls no-op off Android; here they're spies
  // so the arm/disarm/clear lifecycle around the run controls is assertable.
  const journal = {
    resetHrJournal: vi.fn(), armHrJournal: vi.fn(),
    disarmHrJournal: vi.fn(), clearHrJournal: vi.fn(),
  };
  // The indoor foreground-service seam (Android-only in real life), spied so the
  // start/stop lifecycle is assertable.
  const service = { startIndoorSessionService: vi.fn(), stopIndoorSessionService: vi.fn() };
  return { watches, source, journal, service, enabled: false, device: null as { id: string; name?: string } | null, setPairedDevice: vi.fn() };
});

vi.mock("../geo/source", () => ({ geoSource: h.geoSource }));
vi.mock("../hr/source", () => ({ getHrSource: () => (hr.enabled ? hr.source : null) }));
vi.mock("../hr/device", () => ({ getPairedDevice: () => hr.device, setPairedDevice: hr.setPairedDevice }));
vi.mock("../hr/hrJournal", () => hr.journal);
vi.mock("../indoor/session", () => hr.service);
vi.mock("../native", () => ({ isNative: false, isAndroid: false, isIos: false, platform: "web" }));

import { useRunTracker } from "./useRunTracker";

// The recording watch is the one opened with { background: true } (the idle
// preview uses background:false); grab the latest so a test that starts, stops,
// and starts again feeds the current run.
const recording = () => [...h.watchers].reverse().find(w => w.background);
const feed = (w: ReturnType<typeof recording>, coords: { latitude: number; longitude: number; accuracy?: number | null; altitude?: number | null }, timestamp: number) => {
  act(() => { w!.onPos({ coords, timestamp }); });
};

const START = 1_700_000_000_000; // fixed wall clock for deterministic timing

beforeEach(() => {
  localStorage.clear();
  h.watchers.length = 0;
  hr.watches.length = 0;
  hr.enabled = false;
  hr.device = null;
  for (const fn of Object.values(hr.journal)) fn.mockClear();
  h.geoSource.isAvailable.mockReturnValue(true);
  h.geoSource.requestPermissions.mockResolvedValue(true);
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useRunTracker — state machine", () => {
  it("starts idle and transitions idle → tracking → paused → tracking → stopped", () => {
    const { result } = renderHook(() => useRunTracker());
    expect(result.current.state).toBe("idle");

    act(() => result.current.start());
    expect(result.current.state).toBe("tracking");
    expect(recording()).toBeTruthy();

    act(() => result.current.pause());
    expect(result.current.state).toBe("paused");

    act(() => result.current.resume());
    expect(result.current.state).toBe("tracking");

    act(() => result.current.stop());
    expect(result.current.state).toBe("stopped");
  });

  it("reset returns to idle, clears points, and clears the recovery buffer", () => {
    const { result } = renderHook(() => useRunTracker());
    act(() => result.current.start());
    feed(recording(), { latitude: 48.85, longitude: 2.29, accuracy: 8 }, START);
    expect(localStorage.getItem(LIVE_RUN_KEY)).toBeTruthy();

    act(() => result.current.reset());
    expect(result.current.state).toBe("idle");
    expect(result.current.points).toEqual([]);
    expect(localStorage.getItem(LIVE_RUN_KEY)).toBeNull();
  });

  it("stop exposes the run window (startedAt/stoppedAt)", () => {
    const { result } = renderHook(() => useRunTracker());
    act(() => result.current.start());
    vi.setSystemTime(START + 30_000);
    act(() => result.current.stop());
    const win = result.current.runWindow();
    expect(win.startedAt).toBe(START);
    expect(win.stoppedAt).toBe(START + 30_000);
  });

  it("clears the recording watch on stop", () => {
    const { result } = renderHook(() => useRunTracker());
    act(() => result.current.start());
    const w = recording();
    act(() => result.current.stop());
    expect(w!.handle.removed).toBe(true);
  });
});

describe("useRunTracker — onPos filter", () => {
  it("rejects a coarse first fix (warm-up) but anchors on an accurate one", () => {
    const { result } = renderHook(() => useRunTracker());
    act(() => result.current.start());
    const w = recording();

    // accuracy 22 passes accuracyOK (<=25) but fails the 20m warm-up gate → no anchor.
    feed(w, { latitude: 48.85, longitude: 2.29, accuracy: 22 }, START);
    expect(result.current.points.length).toBe(0);

    // A tight fix anchors the track.
    feed(w, { latitude: 48.85, longitude: 2.29, accuracy: 8 }, START + 100);
    expect(result.current.points.length).toBe(1);
  });

  it("drops a fix worse than ACC_MAX_M outright", () => {
    const { result } = renderHook(() => useRunTracker());
    act(() => result.current.start());
    feed(recording(), { latitude: 48.85, longitude: 2.29, accuracy: 40 }, START);
    expect(result.current.points.length).toBe(0);
  });

  it("thins fixes that arrive too soon (< MIN_INTERVAL_MS)", () => {
    const { result } = renderHook(() => useRunTracker());
    act(() => result.current.start());
    const w = recording();
    feed(w, { latitude: 48.8500, longitude: 2.2900, accuracy: 8 }, START);
    // 1s later and moved far — rejected purely on the 2s interval floor.
    feed(w, { latitude: 48.8600, longitude: 2.3000, accuracy: 8 }, START + 1000);
    expect(result.current.points.length).toBe(1);
  });

  it("rejects sub-jitter movement but accepts a real move", () => {
    const { result } = renderHook(() => useRunTracker());
    act(() => result.current.start());
    const w = recording();
    feed(w, { latitude: 48.8500, longitude: 2.2900, accuracy: 8 }, START);
    // ~0.1m away, 3s later: within the jitter floor → rejected.
    feed(w, { latitude: 48.85000001, longitude: 2.29000001, accuracy: 8 }, START + 3000);
    expect(result.current.points.length).toBe(1);
    // ~80m away, another 3s later: real movement → accepted.
    feed(w, { latitude: 48.8507, longitude: 2.2900, accuracy: 8 }, START + 6000);
    expect(result.current.points.length).toBe(2);
  });

  it("inserts a gap marker after a long silence (> GAP_MS)", () => {
    const { result } = renderHook(() => useRunTracker());
    act(() => result.current.start());
    const w = recording();
    feed(w, { latitude: 48.8500, longitude: 2.2900, accuracy: 8 }, START);
    // 90s later (> 60s GAP_MS) and moved → a null gap is inserted before the point.
    feed(w, { latitude: 48.8520, longitude: 2.2900, accuracy: 8 }, START + 90_000);
    expect(result.current.points.length).toBe(3);
    expect(result.current.points[1]).toBeNull(); // gap
    expect(result.current.points[2]).not.toBeNull();
  });

  it("ignores fixes while paused", () => {
    const { result } = renderHook(() => useRunTracker());
    act(() => result.current.start());
    const w = recording();
    feed(w, { latitude: 48.8500, longitude: 2.2900, accuracy: 8 }, START);
    act(() => result.current.pause());
    feed(w, { latitude: 48.8600, longitude: 2.3000, accuracy: 8 }, START + 5000);
    expect(result.current.points.length).toBe(1);
  });

  it("records altitude, rounding it, and preserves null altitude", () => {
    const { result } = renderHook(() => useRunTracker());
    act(() => result.current.start());
    const w = recording();
    feed(w, { latitude: 48.8500, longitude: 2.2900, accuracy: 8, altitude: 35.6 }, START);
    feed(w, { latitude: 48.8507, longitude: 2.2900, accuracy: 8, altitude: null }, START + 3000);
    expect(result.current.points[0]![3]).toBe(36);
    expect(result.current.points[1]![3]).toBeNull();
  });
});

describe("useRunTracker — moving-time accounting", () => {
  it("accumulates only while tracking and freezes across a pause", () => {
    const { result } = renderHook(() => useRunTracker());
    act(() => result.current.start());

    vi.setSystemTime(START + 10_000);
    act(() => result.current.pause());
    expect(result.current.stats.movingSec).toBe(10);

    // 5s paused — must NOT count.
    vi.setSystemTime(START + 15_000);
    act(() => result.current.resume());
    vi.setSystemTime(START + 20_000);
    act(() => result.current.stop());
    expect(result.current.stats.movingSec).toBe(15); // 10 + 5, paused gap excluded
  });
});

describe("useRunTracker — recovery buffer", () => {
  const buffer = (savedAt: number) => JSON.stringify({
    points: [[48.85, 2.29, START, 30], [48.851, 2.29, START + 3000, 31]],
    accSec: 42, hrSamples: [], startAt: null, startedAt: START, stoppedAt: null,
    state: "tracking", savedAt,
  });

  it("offers a fresh in-progress buffer as pending", () => {
    localStorage.setItem(LIVE_RUN_KEY, buffer(START));
    const { result } = renderHook(() => useRunTracker());
    expect(result.current.pending).toBeTruthy();
    expect(result.current.pending!.points!.length).toBe(2);
  });

  it("still offers an old buffer (an interrupted run is never expired away)", () => {
    // Saved 7h ago — past RESUME_MAX_AGE_MS, which only bounds live sharing.
    localStorage.setItem(LIVE_RUN_KEY, buffer(START - 7 * 3600 * 1000));
    const { result } = renderHook(() => useRunTracker());
    expect(result.current.pending).toBeTruthy();
    expect(localStorage.getItem(LIVE_RUN_KEY)).toBeTruthy();
  });

  it("recovers the open segment's moving time for a run that died while tracking", () => {
    // accSec only holds COMPLETED segments; the segment open at the crash
    // (startAt) is closed against the last evidence of recording (savedAt).
    localStorage.setItem(LIVE_RUN_KEY, JSON.stringify({
      points: [[48.85, 2.29, START, 30]], accSec: 42, hrSamples: [],
      startAt: START - 60_000, startedAt: START - 102_000, stoppedAt: null,
      state: "tracking", savedAt: START,
    }));
    const { result } = renderHook(() => useRunTracker());
    act(() => result.current.resumePrevious());
    expect(result.current.stats.movingSec).toBe(102); // 42 completed + 60 open
  });

  it("resumePrevious loads the buffer into a paused session and appends a gap", () => {
    localStorage.setItem(LIVE_RUN_KEY, buffer(START));
    const { result } = renderHook(() => useRunTracker());
    act(() => result.current.resumePrevious());
    expect(result.current.state).toBe("paused");
    expect(result.current.pending).toBeNull();
    // 2 recovered points + a trailing gap marker.
    expect(result.current.points.length).toBe(3);
    expect(result.current.points[2]).toBeNull();
    expect(result.current.stats.movingSec).toBe(42);
    // The pre-crash run window is preserved.
    expect(result.current.runWindow().startedAt).toBe(START);
  });

  it("discardPrevious clears both pending and the stored buffer", () => {
    localStorage.setItem(LIVE_RUN_KEY, buffer(START));
    const { result } = renderHook(() => useRunTracker());
    act(() => result.current.discardPrevious());
    expect(result.current.pending).toBeNull();
    expect(localStorage.getItem(LIVE_RUN_KEY)).toBeNull();
  });
});

describe("useRunTracker — permissions & availability", () => {
  it("requestPermissions returns true and clears any error when granted", async () => {
    h.geoSource.requestPermissions.mockResolvedValue(true);
    const { result } = renderHook(() => useRunTracker());
    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.requestPermissions(); });
    expect(ok).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("requestPermissions surfaces an actionable error when denied", async () => {
    h.geoSource.requestPermissions.mockResolvedValue(false);
    const { result } = renderHook(() => useRunTracker());
    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.requestPermissions(); });
    expect(ok).toBe(false);
    expect(result.current.error).toBeTruthy();
  });

  it("start surfaces an error and does not begin tracking when GPS is unavailable", () => {
    h.geoSource.isAvailable.mockReturnValue(false);
    const { result } = renderHook(() => useRunTracker());
    act(() => result.current.start());
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toBeTruthy();
  });
});

describe("useRunTracker — live heart rate", () => {
  const renderWithStrap = () => {
    hr.enabled = true;
    hr.device = { id: "strap-1" };
    return renderHook(() => useRunTracker({ hrMethod: "bluetooth" }));
  };

  it("connects the sensor while idle and shows the reading before Start", () => {
    const { result } = renderWithStrap();
    expect(result.current.state).toBe("idle");
    expect(hr.watches.length).toBe(1);

    act(() => hr.watches[0].onSample({ bpm: 128, t: START }));
    expect(result.current.stats.hr).toBe(128);
    // hrAt travels with it, so the notification's staleness check reads the
    // instant this bpm was measured rather than the last recorded sample's.
    expect(result.current.stats.hrAt).toBe(START);
    // Display only — a pre-run beat is never part of the run.
    expect(result.current.hrSamples).toEqual([]);
    expect(result.current.stats.hrAvg).toBeNull();
  });

  it("keeps the reading live while paused without recording it", () => {
    const { result } = renderWithStrap();
    act(() => result.current.start());
    act(() => hr.watches[0].onSample({ bpm: 150, t: START + 1000 }));
    act(() => result.current.pause());

    act(() => hr.watches[0].onSample({ bpm: 110, t: START + 20_000 }));
    expect(result.current.stats.hr).toBe(110);
    expect(result.current.stats.hrAt).toBe(START + 20_000);
    // The breather doesn't drag the recorded average down.
    expect(result.current.hrSamples.length).toBe(1);
    expect(result.current.stats.hrAvg).toBe(150);
  });

  it("carries the idle connection into the run rather than reconnecting", () => {
    const { result } = renderWithStrap();
    act(() => hr.watches[0].onSample({ bpm: 128, t: START }));

    act(() => result.current.start());
    expect(hr.watches.length).toBe(1);
    expect(hr.watches[0].stopped).toBe(false);

    act(() => hr.watches[0].onSample({ bpm: 150, t: START + 1000 }));
    expect(result.current.hrSamples).toEqual([{ bpm: 150, t: START + 1000 }]);
    expect(result.current.stats.hrAvg).toBe(150);
    expect(result.current.stats.hr).toBe(150);
  });

  it("stops the sensor on stop, and reconnects a fresh preview after reset", () => {
    const { result } = renderWithStrap();
    act(() => result.current.start());
    act(() => hr.watches[0].onSample({ bpm: 150, t: START + 1000 }));

    act(() => result.current.stop());
    expect(hr.watches[0].stopped).toBe(true);

    act(() => result.current.reset());
    expect(result.current.state).toBe("idle");
    expect(result.current.stats.hr).toBeNull();
    expect(hr.watches.length).toBe(2);
  });

  it("does not connect when nothing is paired, or when HR is off", () => {
    hr.enabled = true;
    hr.device = null;
    renderHook(() => useRunTracker({ hrMethod: "bluetooth" }));
    expect(hr.watches.length).toBe(0);

    hr.enabled = false;
    hr.device = { id: "strap-1" };
    renderHook(() => useRunTracker({ hrMethod: "off" }));
    expect(hr.watches.length).toBe(0);
  });

  it("surfaces the source's connection status and clears it on teardown", () => {
    const { result } = renderWithStrap();
    expect(result.current.hrStatus).toBeNull();
    act(() => hr.watches[0].opts.onStatus!("unreachable"));
    expect(result.current.hrStatus).toBe("unreachable");

    act(() => result.current.start());
    act(() => result.current.stop());
    expect(result.current.hrStatus).toBeNull();
  });

  it("pauses the native journal with the run, so a breather isn't recorded", () => {
    // onHrSample drops beats while paused; the journal has to observe the same
    // pause or the merge at save folds the rest back in, dragging the average
    // down and crediting zone 1 with time spent standing still.
    const { result } = renderWithStrap();
    act(() => result.current.start());
    expect(hr.journal.resetHrJournal).toHaveBeenCalledTimes(1);

    act(() => result.current.pause());
    expect(hr.journal.disarmHrJournal).toHaveBeenCalledTimes(1);

    act(() => result.current.resume());
    // Re-armed, never re-cleared: the beats already on disk are this run's.
    expect(hr.journal.armHrJournal).toHaveBeenCalledTimes(1);
    expect(hr.journal.resetHrJournal).toHaveBeenCalledTimes(1);
  });

  it("clears a leftover journal when the run has no live sensor", () => {
    // A previous BLE run killed before it saved leaves beats on disk. Without a
    // live watch nothing arms the journal, so nothing would clear it either —
    // and they would surface as this run's heart rate.
    hr.enabled = false;
    hr.device = null;
    const { result } = renderHook(() => useRunTracker({ hrMethod: "healthconnect" }));
    act(() => result.current.start());
    expect(hr.journal.clearHrJournal).toHaveBeenCalled();
    expect(hr.journal.resetHrJournal).not.toHaveBeenCalled();
  });

  it("drops a discarded recovery's journal with its buffer", () => {
    const { result } = renderWithStrap();
    act(() => result.current.discardPrevious());
    expect(hr.journal.clearHrJournal).toHaveBeenCalled();
  });

  it("passes the paired identity and persists an address rotation", () => {
    hr.enabled = true;
    hr.device = { id: "strap-1", name: "Polar H10" };
    renderHook(() => useRunTracker({ hrMethod: "bluetooth" }));
    const { opts } = hr.watches[0];
    expect(opts.deviceId).toBe("strap-1");
    expect(opts.deviceName).toBe("Polar H10");
    act(() => opts.onDeviceChange!({ id: "strap-2", name: "Polar H10" }));
    expect(hr.setPairedDevice).toHaveBeenCalledWith({ id: "strap-2", name: "Polar H10" });
  });
});

// Indoor / static cardio (docs/indoor-sessions.md): the same engine with the
// whole geolocation half switched off. What matters is that it records
// (clock + HR) without a geo watch, and that it can never touch the GPS run's
// recovery buffer — an indoor session appearing in the resume offer, or wiping a
// real run's unrecovered points, would be a data-loss bug.
describe("useRunTracker — indoor mode", () => {
  const renderIndoor = () => {
    hr.enabled = true;
    hr.device = { id: "strap-1" };
    return renderHook(() => useRunTracker({ hrMethod: "bluetooth", indoor: true }));
  };

  it("records without ever opening a position watch", () => {
    const { result } = renderIndoor();
    act(() => result.current.start());
    expect(result.current.state).toBe("tracking");
    expect(h.geoSource.watchPosition).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it("starts even where geolocation is unavailable (the web-in-a-gym case)", () => {
    h.geoSource.isAvailable.mockReturnValue(false);
    const { result } = renderIndoor();
    act(() => result.current.start());
    expect(result.current.state).toBe("tracking");
    expect(result.current.error).toBeNull();
  });

  it("still streams and records heart rate, and counts moving time", () => {
    const { result } = renderIndoor();
    act(() => result.current.start());
    act(() => hr.watches[0].onSample({ bpm: 142, t: START + 1000 }));
    vi.setSystemTime(START + 60_000);
    act(() => result.current.stop());

    expect(result.current.stats.hr).toBe(142);
    expect(result.current.stats.hrAvg).toBe(142);
    expect(result.current.stats.movingSec).toBe(60);
    // No distance axis at all, so nothing downstream can quote a pace.
    expect(result.current.stats.km).toBe(0);
    expect(result.current.stats.avgPace).toBe(0);
  });

  it("keeps its buffer under its own key, leaving the GPS one alone", () => {
    localStorage.setItem(LIVE_RUN_KEY, JSON.stringify({ points: [[48.85, 2.29, START, 30]] }));
    const { result } = renderIndoor();
    act(() => result.current.start());
    act(() => hr.watches[0].onSample({ bpm: 142, t: START + 1000 }));

    expect(JSON.parse(localStorage.getItem(INDOOR_RUN_KEY)!).hrSamples).toHaveLength(1);
    // The interrupted GPS run is still there, untouched, and a reset/finalize
    // must not be what deletes it.
    act(() => result.current.reset());
    expect(localStorage.getItem(LIVE_RUN_KEY)).toBeTruthy();
    expect(localStorage.getItem(INDOOR_RUN_KEY)).toBeNull();
  });

  // Nothing else writes the buffer in a strapless session — no fixes, no HR
  // samples — so before the clock tick refreshed it, a session killed in the
  // foreground recovered a 0:00 clock however long it had been running.
  it("keeps the recovery buffer's clock fresh with no sensor writing to it", () => {
    const { result } = renderHook(() => useRunTracker({ indoor: true }));
    act(() => result.current.start());
    act(() => { vi.advanceTimersByTime(60_000); });

    const buf = JSON.parse(localStorage.getItem(INDOOR_RUN_KEY)!);
    expect(buf.state).toBe("tracking");
    expect(buf.startAt).toBe(START);
    expect(Date.now() - buf.savedAt).toBeLessThanOrEqual(10_000);
    // What the resume offer actually reads back: accSec + the open segment.
    expect(normalizeRecovery(buf).accSec).toBeGreaterThanOrEqual(50);
  });

  // Nothing else holds the process for an indoor session — no geo watch means no
  // location foreground service — so Android reclaimed the WebView renderer of a
  // backgrounded one and froze the recorder. See docs/indoor-sessions.md.
  describe("the foreground service that holds the session", () => {
    it("runs for the length of a session recorded with a strap", () => {
      hr.enabled = true;
      hr.device = { id: "strap-1" };
      const { result } = renderHook(() => useRunTracker({ hrMethod: "bluetooth", indoor: true }));

      act(() => result.current.start());
      expect(hr.service.startIndoorSessionService).toHaveBeenCalledWith(START);

      // A pause records nothing, so it hands the process back.
      act(() => result.current.pause());
      expect(hr.service.stopIndoorSessionService).toHaveBeenCalled();
      hr.service.startIndoorSessionService.mockClear();
      act(() => result.current.resume());
      expect(hr.service.startIndoorSessionService).toHaveBeenCalled();

      hr.service.stopIndoorSessionService.mockClear();
      act(() => result.current.stop());
      expect(hr.service.stopIndoorSessionService).toHaveBeenCalled();
    });

    // The service is declared connectedDevice, so it must not run when there is
    // no connected device to justify it.
    it("never runs without a live strap streaming", () => {
      hr.enabled = false;
      hr.device = null;
      const { result } = renderHook(() => useRunTracker({ indoor: true }));
      act(() => result.current.start());
      expect(hr.service.startIndoorSessionService).not.toHaveBeenCalled();
    });

    // It holds the whole app process, so an orphaned one would pin a
    // notification to a session that no longer exists.
    it("is handed back when the recorder unmounts", () => {
      hr.enabled = true;
      hr.device = { id: "strap-1" };
      const { result, unmount } = renderHook(() => useRunTracker({ hrMethod: "bluetooth", indoor: true }));
      act(() => result.current.start());
      hr.service.stopIndoorSessionService.mockClear();
      unmount();
      expect(hr.service.stopIndoorSessionService).toHaveBeenCalled();
    });

    // A GPS run is held by the location service instead — starting a second one
    // would put two "recording" notifications on the lock screen.
    it("stays out of a GPS run entirely", () => {
      hr.enabled = true;
      hr.device = { id: "strap-1" };
      const { result } = renderHook(() => useRunTracker({ hrMethod: "bluetooth" }));
      act(() => result.current.start());
      expect(hr.service.startIndoorSessionService).not.toHaveBeenCalled();
    });
  });

  it("never offers a GPS run as an indoor session to resume", () => {
    localStorage.setItem(LIVE_RUN_KEY, JSON.stringify({
      points: [[48.85, 2.29, START, 30]], accSec: 120, state: "tracking", savedAt: START,
    }));
    const { result } = renderIndoor();
    expect(result.current.pending).toBeNull();
  });
});
