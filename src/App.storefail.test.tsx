import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// A signed-in user whose app_state read fails must NOT be dropped into the app
// with an empty store — that renders as a brand-new account and pushes them
// through onboarding, which is exactly how a real user's runs and plan got
// overwritten. They get a retry screen instead.

const h = vi.hoisted(() => ({
  initStore: vi.fn(async () => false),
  signOut: vi.fn(async () => ({ error: null })),
  flushNow: vi.fn(async () => {}),
}));

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { user: { id: "u1" } } } })),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: h.signOut,
      exchangeCodeForSession: vi.fn(),
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
  },
  AUTH_DEEP_LINK: "x://auth",
  authRedirectTo: () => "x://auth",
}));

vi.mock("./native", () => ({ isNative: false, isIos: false, isAndroid: false, platform: "web" }));

vi.mock("./db", () => ({
  initStore: h.initStore,
  clearStore: vi.fn(),
  db: { get: vi.fn(async () => null), set: vi.fn() },
  currentUserId: () => "u1",
  flushNow: h.flushNow,
  isStoreLoaded: () => false,
}));

vi.mock("./marketing/MarketingGate", () => ({ default: () => <div>Marketing landing</div> }));

import App from "./App";

describe("app_state load failure", () => {
  beforeEach(() => {
    h.initStore.mockClear().mockResolvedValue(false);
    h.signOut.mockClear();
    h.flushNow.mockClear();
  });

  it("shows a retry screen instead of the app", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Couldn't load your data/i)).toBeInTheDocument());
    // Not the onboarding wizard, and not a silently-empty dashboard.
    expect(screen.queryByText(/days to go/i)).not.toBeInTheDocument();
  });

  it("retries the load and enters the app once it succeeds", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Couldn't load your data/i)).toBeInTheDocument());
    expect(h.initStore).toHaveBeenCalledTimes(1);

    h.initStore.mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(h.initStore).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText(/Couldn't load your data/i)).not.toBeInTheDocument());
  });

  it("offers a sign-out that flushes first", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Couldn't load your data/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    await waitFor(() => expect(h.signOut).toHaveBeenCalled());
    expect(h.flushNow).toHaveBeenCalled();
  });
});
