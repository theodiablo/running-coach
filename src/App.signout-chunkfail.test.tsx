import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => {
  const state: { authCb: ((e: string, s: unknown) => void) | null; currentSession: unknown } = {
    authCb: null,
    currentSession: { user: { id: "u1" } },
  };
  const signOut = vi.fn(async () => {
    state.currentSession = null;
    state.authCb?.("SIGNED_OUT", null);
    return { error: null };
  });
  return { state, signOut };
});

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
    channel: () => ({ on: () => ({ subscribe: (cb?: (s: string) => void) => { cb?.("SUBSCRIBED"); return {}; } }) }),
    removeChannel: vi.fn(),
  },
  AUTH_DEEP_LINK: "x://auth",
  authRedirectTo: () => "x://auth",
}));

vi.mock("./native", () => ({ isNative: false, isIos: false, isAndroid: false, platform: "web" }));

vi.mock("./db", () => ({
  initStore: vi.fn(async () => "loaded"),
  clearStore: vi.fn(),
  db: { get: vi.fn(async () => null), set: vi.fn() },
  currentUserId: () => "u1",
  flushNow: vi.fn(async () => {}),
  subscribeStoreRefresh: () => () => {},
  clearOfflineMirror: vi.fn(),
}));

// Simulate the real-world failure: a signed-in user has never loaded the
// marketing chunk, and by the time they sign out the CDN has rotated (redeploy)
// so the dynamic import 404s. The rejection surfaces from the marketing subtree
// as a "Failed to fetch dynamically imported module" error — reproduce that
// exact error reaching the boundary by throwing it from the component.
vi.mock("./marketing/MarketingGate", () => ({
  default: () => {
    throw new Error("Failed to fetch dynamically imported module: /assets/MarketingGate-a1b2c3.js");
  },
}));

import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

describe("sign out with a failed marketing chunk load", () => {
  beforeEach(() => {
    h.state.currentSession = { user: { id: "u1" } };
    h.signOut.mockClear();
  });

  it("does not crash the whole app into the error boundary", async () => {
    render(<ErrorBoundary><App /></ErrorBoundary>);
    await waitFor(() => expect(screen.queryByText(/Something went wrong/i)).not.toBeInTheDocument());

    await act(async () => {
      await h.signOut();
    });

    // Give the failed lazy import a tick to reject and surface.
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    await waitFor(() => {
      // The signed-out user should still be able to sign back in, not be
      // stranded on the crash screen. The marketing chunk failed, so we fall
      // back to the statically-imported LoginScreen.
      expect(screen.queryByText(/Something went wrong/i)).not.toBeInTheDocument();
      expect(screen.getAllByText(/sign in|log in|sign up/i).length).toBeGreaterThan(0);
    });
  });
});
