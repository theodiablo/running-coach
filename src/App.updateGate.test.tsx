import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

// The hard update gate: a "Check again" whose config read fails must leave it standing.

const h = vi.hoisted(() => ({
  config: { data: null as unknown, error: null as unknown },
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
    getLaunchUrl: vi.fn(async () => undefined),
    getInfo: vi.fn(async () => ({ version: "1.0.0" })),
  },
}));
vi.mock("@capacitor/browser", () => ({ Browser: { close: vi.fn(async () => {}) } }));

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(() => new Promise(() => {})),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: vi.fn(),
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => h.config }) }) }),
  },
  AUTH_DEEP_LINK: "x://auth",
  authRedirectTo: () => "x://auth",
}));

vi.mock("./native", () => ({ isNative: true, isIos: false, isAndroid: true, platform: "android" }));
vi.mock("./storeBridge", () => ({
  // Play has nothing for this install yet: the gate says "on its way".
  playUpdateInfo: vi.fn(async () => ({ available: false, inProgress: false, flexibleAllowed: true, immediateAllowed: true, versionCode: 1, stalenessDays: 0, status: "unknown" })),
  installInfo: vi.fn(async () => ({ fromStore: true })),
  onPlayInstallState: () => () => {},
  startPlayUpdate: vi.fn(async () => null),
  completePlayUpdate: vi.fn(async () => {}),
  openAppStorePage: vi.fn(async () => false),
}));
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
vi.mock("./RunningCoach", () => ({ default: () => <div>APP CONTENT</div> }));

import App from "./App";

describe("hard update gate", () => {
  beforeEach(() => {
    h.config = { data: { min_supported_version: "2.0.0", latest_version: "2.0.0" }, error: null };
  });

  it("stays up when a recheck can't read the config", async () => {
    render(<App />);
    await act(async () => {});
    expect(screen.getByText("Update required")).toBeInTheDocument();
    expect(screen.getByText(/still on its way to Google Play/)).toBeInTheDocument();

    h.config = { data: null, error: { message: "offline" } };
    vi.spyOn(console, "error").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await act(async () => {});
    expect(screen.getByText("Update required")).toBeInTheDocument();
  });

  it("lifts once the config says this version is fine", async () => {
    render(<App />);
    await act(async () => {});
    h.config = { data: { min_supported_version: "1.0.0", latest_version: "2.0.0" }, error: null };
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await act(async () => {});
    expect(screen.queryByText("Update required")).toBeNull();
  });
});
