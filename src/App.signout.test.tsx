import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";

// --- Mock supabase ---------------------------------------------------------
const h = vi.hoisted(() => {
  const state: {
    authCb: ((event: string, session: unknown) => void) | null;
    currentSession: unknown;
  } = { authCb: null, currentSession: { user: { id: "u1" } } };
  const signOut = vi.fn(async () => {
    state.currentSession = null;
    state.authCb?.("SIGNED_OUT", null);
    return { error: null };
  });
  return { state, signOut };
});
const signOut = h.signOut;

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: h.state.currentSession } })),
      onAuthStateChange: (cb: (e: string, s: unknown) => void) => {
        h.state.authCb = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
      signOut: h.signOut,
      exchangeCodeForSession: vi.fn(),
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
  },
  AUTH_DEEP_LINK: "x://auth",
  authRedirectTo: () => "x://auth",
}));

vi.mock("./native", () => ({ isNative: false, isIos: false, isAndroid: false, platform: "web" }));

const store: Record<string, unknown> = {
  rc_settings: {
    raceDate: "2026-10-01", goalSec: 3600, distanceKm: 10, raceElevation: 0,
    name: "Theo", age: 30, maxHR: 190, restHR: 60, onboarded: true, onboardStep: 0,
    intent: "race", healthAck: { v: 1, at: "2026-01-01" }, hrMethod: "off", hrOptOut: false,
    planSessions: [{ dayOffset: 2, minutes: 30 }, { dayOffset: 6, minutes: 60 }],
  },
  rc_runs: [
    { id: "r1", date: "2026-07-01", type: "EASY", km: 5, durationSec: 1800, hr: 0, hrMax: 0, elevation: 0, effort: 3, notes: "" },
  ],
  rc_plan: {
    raceDate: "2026-10-01", goalSec: 3600, distanceKm: 10,
    weeks: [{ weekNumber: 1, startDate: "2026-07-06", phase: "BASE", sessions: [
      { id: "w1d2", date: "2026-07-08", type: "EASY", desc: "Easy run", km: 5, pace: "6:00", done: false },
      { id: "w1d6", date: "2026-07-12", type: "LONG", desc: "Long run", km: 10, pace: "6:30", done: false },
    ] }],
  },
  rc_races: { participations: [], seenBadges: [] },
};

vi.mock("./db", () => ({
  initStore: vi.fn(async () => "loaded"),
  clearStore: vi.fn(),
  db: { get: vi.fn(async (k: string) => (k in store ? store[k] : null)), set: vi.fn() },
  currentUserId: () => "u1",
  flushNow: vi.fn(async () => {}),
  subscribeStoreRefresh: () => () => {},
  clearOfflineMirror: vi.fn(),
}));

// Force the web marketing gate to be a trivial component so we exercise the
// signed-out web branch without loading the real (font-importing) chunk.
vi.mock("./marketing/MarketingGate", () => ({ default: () => <div>Marketing landing</div> }));

import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

describe("sign out", () => {
  beforeEach(() => {
    h.state.currentSession = { user: { id: "u1" } };
    signOut.mockClear();
  });

  it("returns to the logged-out landing without hitting the error boundary", async () => {
    render(<ErrorBoundary><App /></ErrorBoundary>);
    // Wait until the signed-in dashboard has rendered.
    await waitFor(() => expect(screen.getByText(/days to go/i)).toBeInTheDocument());

    await act(async () => {
      await signOut();
    });

    await waitFor(() => {
      expect(screen.getByText(/Marketing landing/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Something went wrong/i)).not.toBeInTheDocument();
  });
});
