import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

// An offline cold start with an expired access token: supabase-js preserves
// the session in storage but getSession() resolves `session: null`, which used
// to drop a signed-in runner on the login screen for lack of a network. The
// app must adopt the stored session and proceed to the (offline-booted) store.

const h = vi.hoisted(() => ({
  initStore: vi.fn(async (): Promise<string> => "offline"),
}));

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: vi.fn(),
      exchangeCodeForSession: vi.fn(),
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    channel: () => ({ on: () => ({ subscribe: (cb?: (s: string) => void) => { cb?.("SUBSCRIBED"); return {}; } }) }),
    removeChannel: vi.fn(),
  },
  AUTH_DEEP_LINK: "x://auth",
  authRedirectTo: () => "x://auth",
}));

vi.mock("./native", () => ({ isNative: false, isIos: false, isAndroid: false, platform: "web" }));

vi.mock("./db", () => ({
  initStore: h.initStore,
  clearStore: vi.fn(),
  db: { get: vi.fn(async () => null), set: vi.fn() },
  currentUserId: () => "u-off",
  flushNow: vi.fn(async () => {}),
  isStoreLoaded: () => true,
  subscribeStoreRefresh: () => () => {},
  clearOfflineMirror: vi.fn(),
}));

vi.mock("./marketing/MarketingGate", () => ({ default: () => <div>Marketing landing</div> }));
vi.mock("./RunningCoach", () => ({ default: () => <div>APP CONTENT</div> }));

import App from "./App";
import { supabase } from "./supabase";
import { SUPABASE_URL } from "./config";
import { supabaseStorageKey } from "./utils/offlineSession";

describe("offline session fallback", () => {
  beforeEach(() => {
    localStorage.clear();
    h.initStore.mockClear().mockResolvedValue("offline");
  });

  it("boots into the app from the stored session when getSession comes back empty", async () => {
    localStorage.setItem(supabaseStorageKey(SUPABASE_URL), JSON.stringify({
      access_token: "at", refresh_token: "rt",
      expires_at: Math.floor(Date.now() / 1000) - 3600, // expired an hour ago
      user: { id: "u-off" },
    }));
    render(<App />);
    await waitFor(() => expect(screen.getByText("APP CONTENT")).toBeInTheDocument());
    expect(h.initStore).toHaveBeenCalledWith("u-off");
    expect(screen.queryByText(/Marketing landing/i)).not.toBeInTheDocument();
  });

  it("still shows the signed-out landing when no session is stored", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Marketing landing/i)).toBeInTheDocument());
    expect(h.initStore).not.toHaveBeenCalled();
  });

  // A weak network (a race start line): the expired token's refresh retries for ~30s, and
  // getSession() waits on it. A recently-live stored session must open the app well before.
  describe("while the token refresh is stuck", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.mocked(supabase.auth.getSession).mockImplementationOnce(() => new Promise(() => {}));
    });
    afterEach(() => { vi.useRealTimers(); });

    it("opens from the stored session within a few seconds", async () => {
      localStorage.setItem(supabaseStorageKey(SUPABASE_URL), JSON.stringify({
        access_token: "at", refresh_token: "rt",
        expires_at: Math.floor(Date.now() / 1000) - 3600,
        user: { id: "u-off" },
      }));
      render(<App />);
      expect(screen.queryByText("APP CONTENT")).not.toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(screen.getByText("APP CONTENT")).toBeInTheDocument();
      expect(h.initStore).toHaveBeenCalledWith("u-off");
    });

    it("keeps waiting, not the login screen, when nothing is stored", async () => {
      render(<App />);
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(screen.queryByText(/Marketing landing/i)).not.toBeInTheDocument();
      expect(h.initStore).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(screen.getByText(/Marketing landing/i)).toBeInTheDocument();
    });
  });
});
