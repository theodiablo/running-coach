import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PLAY_STORE_URL } from "../constants";

// Mutable platform flags so one file can exercise both shells; the component
// reads the imported bindings at call time, so getters stay live per-test.
const platform = { isAndroid: false, isIos: false };
vi.mock("../native", () => ({
  get isAndroid() { return platform.isAndroid; },
  get isIos() { return platform.isIos; },
}));

const { browserOpen } = vi.hoisted(() => ({ browserOpen: vi.fn() }));
vi.mock("@capacitor/browser", () => ({ Browser: { open: browserOpen } }));

import { UpdateCard, UpdateRequired } from "./UpdatePrompt";
import { UPDATE_DISMISSED_KEY } from "../constants";

beforeEach(() => {
  vi.clearAllMocks();
  browserOpen.mockResolvedValue(undefined);
  platform.isAndroid = false;
  platform.isIos = false;
  localStorage.clear();
});

describe("UpdateCard", () => {
  it("Android: opens the Play Store via plain navigation, never @capacitor/browser", async () => {
    // Regression: routing the store link through @capacitor/browser (Chrome
    // Custom Tabs) crashed the app on-device. Android must use a top-frame
    // navigation, which Capacitor hands to the OS as an ACTION_VIEW intent.
    platform.isAndroid = true;
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign } as unknown as Location);

    render(<UpdateCard version="1.16.1" />);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith(PLAY_STORE_URL));
    expect(browserOpen).not.toHaveBeenCalled();
  });

  it("non-Android: opens the store via the Browser plugin", async () => {
    render(<UpdateCard version="1.16.1" />);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(browserOpen).toHaveBeenCalledWith({ url: PLAY_STORE_URL }));
  });

  it("names the version and the platform's store", () => {
    render(<UpdateCard version="1.16.1" />);
    expect(screen.getByText("Version 1.16.1 is ready")).toBeInTheDocument();
    expect(screen.getByText(/Google Play/)).toBeInTheDocument();
  });

  it("iOS: hides the store button while APP_STORE_URL is unset", () => {
    platform.isIos = true;
    render(<UpdateCard version="1.16.1" />);
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    // The copy (and the dismiss controls) still tell the user to update.
    expect(screen.getByText(/App Store/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Later" })).toBeInTheDocument();
  });

  it.each(["Dismiss", "Later"])("%s hides it for that version, across launches", (name) => {
    const { unmount } = render(<UpdateCard version="1.16.1" />);
    fireEvent.click(screen.getByRole("button", { name }));
    expect(screen.queryByText("Version 1.16.1 is ready")).toBeNull();
    expect(localStorage.getItem(UPDATE_DISMISSED_KEY)).toBe("1.16.1");

    unmount();
    render(<UpdateCard version="1.16.1" />);
    expect(screen.queryByText("Version 1.16.1 is ready")).toBeNull();
  });

  it("comes back for a newer version", () => {
    localStorage.setItem(UPDATE_DISMISSED_KEY, "1.16.1");
    render(<UpdateCard version="1.17.0" />);
    expect(screen.getByText("Version 1.17.0 is ready")).toBeInTheDocument();
  });
});

describe("UpdateRequired", () => {
  it("Android: the hard gate's button also uses plain navigation", async () => {
    platform.isAndroid = true;
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign } as unknown as Location);

    render(<UpdateRequired />);
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith(PLAY_STORE_URL));
    expect(browserOpen).not.toHaveBeenCalled();
  });
});
