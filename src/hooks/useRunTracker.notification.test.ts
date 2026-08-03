import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

// What the tracker pushes to the lock-screen notification, for a track whose
// numbers are known by construction. This is also the reference the ANDROID side
// has to reproduce: the foreground service re-renders the same message from the
// `live` seed while the WebView is frozen (patched plugin — see
// docs/live-tracking.md), so if the pushed text or seed changes here, the Java
// renderer has to change with it.

const h = vi.hoisted(() => {
  type Watcher = { onPos: (p: unknown) => void; background: boolean };
  const watchers: Watcher[] = [];
  const geoSource = {
    isAvailable: () => true,
    checkPermissions: async () => false,
    requestPermissions: async () => true,
    watchPosition: (onPos: (p: unknown) => void, _onErr?: unknown, opts?: { background?: boolean }) => {
      watchers.push({ onPos, background: !!opts?.background });
      return { id: "w", removed: false };
    },
    clearWatch: () => {},
  };
  const pushed: unknown[] = [];
  return { watchers, geoSource, pushed };
});

vi.mock("../geo/source", () => ({ geoSource: h.geoSource }));
vi.mock("../hr/source", () => ({ getHrSource: () => null }));
vi.mock("../hr/device", () => ({ getPairedDevice: () => null }));
vi.mock("../native", () => ({ isNative: true, isAndroid: false, isIos: false, platform: "ios" }));
vi.mock("../geo/liveNotification", () => ({
  pushRunNotification: (content: unknown) => { h.pushed.push(content); },
  resetRunNotification: () => {},
}));

import { useRunTracker } from "./useRunTracker";
import type { RunNotificationContent } from "../utils/runNotification";

const START = 1_700_000_000_000;
const LAT = 48, LNG = 2;
const STEP_DEG = 9e-5;   // ≈ 10.008 m north per fix, on the tracker's 6371km sphere
const STEP_MS = 5000;    // one fix every 5s → ≈ 500 s/km
const FIXES = 12;

const last = () => h.pushed[h.pushed.length - 1] as RunNotificationContent;

beforeEach(() => {
  localStorage.clear();
  h.watchers.length = 0;
  h.pushed.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => { vi.useRealTimers(); });

// Walks a straight line north at a steady pace, keeping the wall clock in step
// with the fix timestamps so moving time matches the track.
function runStraightLine(feed: (p: unknown) => void) {
  for (let i = 0; i < FIXES; i++) {
    const t = START + i * STEP_MS;
    vi.setSystemTime(t);
    act(() => feed({ coords: { latitude: LAT + i * STEP_DEG, longitude: LNG, accuracy: 5, altitude: 100 }, timestamp: t }));
  }
}

describe("useRunTracker — lock-screen notification", () => {
  it("pushes distance, current pace and the live seed the native renderer extrapolates from", () => {
    const { result } = renderHook(() => useRunTracker());
    act(() => result.current.start());
    runStraightLine(h.watchers.find(w => w.background)!.onPos);

    // 11 legs of ~10.008m; current pace over the last 30s (6 legs / 30s).
    expect(last().message).toBe("0.11 km · 8:20/km");
    expect(last().titleKey).toBe("title");
    expect(last().chronometerStartMs).toBe(START); // now - movingMs, i.e. the run start
    expect(last().live.tracking).toBe(true);
    expect(last().live.km).toBeCloseTo(0.11008, 5);
    expect(last().live.paceSecPerKm).toBeCloseTo(499.62, 2);
    expect(last().live.hr).toBeNull();
    expect(last().live.hrAtMs).toBeNull();
  });

  it("freezes the clock into the text and stops the seed's accumulation on pause", () => {
    const { result } = renderHook(() => useRunTracker());
    act(() => result.current.start());
    runStraightLine(h.watchers.find(w => w.background)!.onPos);
    act(() => result.current.pause());

    expect(last().titleKey).toBe("pausedTitle");
    expect(last().chronometerStartMs).toBeNull();
    // Paused switches to average pace, which a steady line runs at anyway.
    expect(last().message).toBe("0:55 · 0.11 km · 8:20/km");
    expect(last().live.tracking).toBe(false); // native must ignore fixes too
  });
});
