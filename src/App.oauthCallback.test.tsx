import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// A native OAuth callback lands signed out: whatever happens to it, the login
// screen says so and the funnel records how it ended.

const h = vi.hoisted(() => ({
  launchUrl: null as string | null,
  exchange: vi.fn(async (): Promise<unknown> => ({ data: { session: null, user: null }, error: null })),
  track: vi.fn(),
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
      getSession: vi.fn(async () => ({ data: { session: null } })),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: vi.fn(),
      exchangeCodeForSession: h.exchange,
      signInWithOAuth: vi.fn(),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      resetPasswordForEmail: vi.fn(),
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
  },
  AUTH_DEEP_LINK: "x://auth",
  authRedirectTo: () => "x://auth",
}));

vi.mock("./native", () => ({ isNative: true, isIos: true, isAndroid: false, platform: "ios" }));
vi.mock("./telemetry", async (orig) => ({ ...(await orig<typeof import("./telemetry")>()), track: h.track }));

vi.mock("./db", () => ({
  initStore: vi.fn(async () => "loaded"),
  clearStore: vi.fn(),
  db: { get: vi.fn(async () => null), set: vi.fn() },
  currentUserId: () => null,
  flushNow: vi.fn(async () => {}),
  isStoreLoaded: () => true,
  subscribeStoreRefresh: () => () => {},
  subscribeStoreReconciled: () => () => {},
  clearOfflineMirror: vi.fn(),
}));

vi.mock("./RunningCoach", () => ({ default: () => <div>The app</div> }));

import App from "./App";
import { oauthOpened } from "./auth/authTelemetry";

beforeEach(() => {
  h.track.mockClear();
  h.exchange.mockReset();
});

describe("native OAuth callback, signed out", () => {
  it("points an unexchangeable email link at the password sign-in, rather than saying nothing", async () => {
    h.launchUrl = "solutions.camboulive.run://auth-callback?code=c1";
    h.exchange.mockResolvedValue({
      data: { session: null, user: null },
      error: Object.assign(new Error("PKCE code verifier not found in storage."), { code: "pkce_code_verifier_not_found", status: 400 }),
    });
    render(<App />);
    expect(await screen.findByText(/That link couldn't sign you in here/)).toBeInTheDocument();
    expect(screen.queryByText(/PKCE/)).not.toBeInTheDocument();
    expect(h.track).toHaveBeenCalledWith("auth_failed", { method: "deeplink", stage: "exchange", code: "pkce_code_verifier_not_found" });
  });

  it("asks for another try when a Google sign-in started here is refused", async () => {
    oauthOpened("google");
    h.launchUrl = "solutions.camboulive.run://auth-callback?code=c3";
    h.exchange.mockResolvedValue({ data: { session: null, user: null }, error: Object.assign(new Error("invalid flow state"), { code: "flow_state_not_found", status: 404 }) });
    render(<App />);
    expect(await screen.findByText("Sign-in didn't finish. Please try again.")).toBeInTheDocument();
    expect(h.track).toHaveBeenCalledWith("auth_failed", { method: "google", stage: "exchange", code: "flow_state_not_found" });
  });

  it("records a completed exchange", async () => {
    h.launchUrl = "solutions.camboulive.run://auth-callback?code=c2";
    h.exchange.mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null });
    render(<App />);
    await waitFor(() => expect(h.track).toHaveBeenCalledWith("auth_completed", { method: "deeplink" }));
  });

  it("records the provider's own error code, never its description", async () => {
    h.launchUrl = "solutions.camboulive.run://auth-callback?error=access_denied&error_description=User%20cancelled";
    render(<App />);
    expect(await screen.findByText("User cancelled")).toBeInTheDocument();
    expect(h.track).toHaveBeenCalledWith("auth_failed", { method: "deeplink", stage: "provider", code: "access_denied" });
  });
});
