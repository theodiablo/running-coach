import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

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
});
