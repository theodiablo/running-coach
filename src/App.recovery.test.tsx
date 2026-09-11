import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// A password-reset link must land on the new-password screen — not on the app
// (with the password the user came to replace still unknown), and not on the
// marketing site, whose login modal is closed by default.

const h = vi.hoisted(() => {
  // Set before App is evaluated: App captures the URL at module load, because
  // supabase-js strips its own params as soon as it reads them.
  window.history.replaceState({}, "", "/?token_hash=reset-token&type=recovery");
  return {
    session: { user: { id: "u1", email: "runner@example.com" } } as { user: { id: string; email: string } } | null,
    verifyOtp: vi.fn(async () => ({ error: null as unknown })),
    updateUser: vi.fn(async () => ({ error: null as unknown })),
  };
});

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: h.session } })),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: vi.fn(),
      exchangeCodeForSession: vi.fn(),
      verifyOtp: h.verifyOtp,
      updateUser: h.updateUser,
      signInWithOAuth: vi.fn(),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      resetPasswordForEmail: vi.fn(async () => ({ error: null })),
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
  isStoreLoaded: () => true,
  subscribeStoreRefresh: () => () => {},
  clearOfflineMirror: vi.fn(),
}));

vi.mock("./RunningCoach", () => ({ default: () => <div>The app</div> }));
vi.mock("./marketing/MarketingGate", () => ({ default: () => <div>Marketing landing</div> }));

import App from "./App";

describe("password-reset callback", () => {
  beforeEach(() => {
    h.session = { user: { id: "u1", email: "runner@example.com" } };
    h.verifyOtp.mockClear().mockResolvedValue({ error: null });
    h.updateUser.mockClear().mockResolvedValue({ error: null });
  });

  it("spends the link and holds the app behind the new-password screen", async () => {
    render(<App />);

    await screen.findByText("Choose a new password");
    expect(h.verifyOtp).toHaveBeenCalledWith({ token_hash: "reset-token", type: "recovery" });
    expect(screen.queryByText("The app")).not.toBeInTheDocument();
    // The token is single-use: leaving it in the URL would make a reload look
    // like a dead link.
    expect(window.location.search).not.toContain("reset-token");
  });

  it("lets the user into the app once the new password is saved", async () => {
    render(<App />);
    await screen.findByText("Choose a new password");

    fireEvent.change(screen.getByPlaceholderText("New password"), { target: { value: "Correct9Horse" } });
    fireEvent.change(screen.getByPlaceholderText("Confirm new password"), { target: { value: "Correct9Horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    await waitFor(() => expect(h.updateUser).toHaveBeenCalledWith({ password: "Correct9Horse" }));
    await screen.findByText("The app");
  });

  it("sends a signed-out user to the reset form when the link is dead", async () => {
    h.session = null;
    h.verifyOtp.mockResolvedValue({ error: Object.assign(new Error("Token has expired"), { code: "otp_expired" }) });

    render(<App />);

    await screen.findByText(/expired or has already been used/);
    // Never the marketing page: the way to ask for a fresh link is behind a
    // CTA nobody would know to press.
    expect(screen.queryByText("Marketing landing")).not.toBeInTheDocument();
  });
});
