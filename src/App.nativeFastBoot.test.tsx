import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";

// Native cold start on a weak network: the fast boot opens the stored session while the token
// refresh crawls, unless the app was launched by an auth deep link, whose own session is the one
// to use (the stored one may be another account's).

const h = vi.hoisted(() => ({
  launchUrl: null as string | null,
  verifyOtp: vi.fn((): Promise<unknown> => new Promise(() => {})),
  initStore: vi.fn(async (): Promise<string> => "slow"),
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
    getLaunchUrl: vi.fn(async () => (h.launchUrl ? { url: h.launchUrl } : undefined)),
    getInfo: vi.fn(async () => ({ version: "1.0.0" })),
  },
}));
vi.mock("@capacitor/browser", () => ({ Browser: { close: vi.fn(async () => {}) } }));

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(() => new Promise(() => {})), // the refresh never settles
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: vi.fn(),
      exchangeCodeForSession: vi.fn(() => new Promise(() => {})),
      verifyOtp: h.verifyOtp,
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => new Promise(() => {}) }) }) }),
  },
  AUTH_DEEP_LINK: "x://auth",
  authRedirectTo: () => "x://auth",
}));

vi.mock("./native", () => ({ isNative: true, isIos: false, isAndroid: true, platform: "android" }));

vi.mock("./db", () => ({
  initStore: h.initStore,
  clearStore: vi.fn(),
  db: { get: vi.fn(async () => null), set: vi.fn() },
  currentUserId: () => "u-stored",
  flushNow: vi.fn(async () => {}),
  isStoreLoaded: () => true,
  subscribeStoreRefresh: () => () => {},
  subscribeStoreReconciled: () => () => {},
  clearOfflineMirror: vi.fn(),
}));

vi.mock("./RunningCoach", () => ({ default: () => <div>APP CONTENT</div> }));

import App from "./App";
import { SUPABASE_URL } from "./config";
import { supabaseStorageKey } from "./utils/offlineSession";

describe("native fast boot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    h.initStore.mockClear();
    localStorage.setItem(supabaseStorageKey(SUPABASE_URL), JSON.stringify({
      access_token: "at", refresh_token: "rt",
      expires_at: Math.floor(Date.now() / 1000) - 3600,
      user: { id: "u-stored" },
    }));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("opens the stored session when launched normally", async () => {
    h.launchUrl = null;
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(h.initStore).toHaveBeenCalledWith("u-stored");
    expect(screen.getByText("APP CONTENT")).toBeInTheDocument();
  });

  it("waits for the link's own session when launched by a password-reset link", async () => {
    h.launchUrl = "solutions.camboulive.run://auth-callback?token_hash=abc&type=recovery";
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(h.initStore).not.toHaveBeenCalled();
    expect(screen.queryByText("APP CONTENT")).not.toBeInTheDocument();
  });

  it("opens the stored session as soon as a link that came in late turns out dead", async () => {
    h.launchUrl = "solutions.camboulive.run://auth-callback?token_hash=expired&type=recovery";
    h.verifyOtp.mockImplementationOnce(() => new Promise((resolve) => {
      setTimeout(() => resolve({ data: { user: null }, error: { message: "Token has expired" } }), 4000);
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(h.initStore).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(h.initStore).toHaveBeenCalledWith("u-stored"); // not left on the splash until the 20s net
  });
});
