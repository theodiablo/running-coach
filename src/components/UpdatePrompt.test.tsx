import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PLAY_STORE_URL, UPDATE_DISMISSED_KEY } from "../constants";

// Mutable platform flags so one file can exercise both shells; the component
// reads the imported bindings at call time, so getters stay live per-test.
const platform = { isAndroid: false, isIos: false };
vi.mock("../native", () => ({
  get isAndroid() { return platform.isAndroid; },
  get isIos() { return platform.isIos; },
}));

const { browserOpen, bridge } = vi.hoisted(() => ({
  browserOpen: vi.fn(),
  bridge: { startPlayUpdate: vi.fn(), completePlayUpdate: vi.fn(), openAppStorePage: vi.fn() },
}));
vi.mock("@capacitor/browser", () => ({ Browser: { open: browserOpen } }));
vi.mock("../storeBridge", () => bridge);

import { UpdateCard, UpdateRequired } from "./UpdatePrompt";

const store = (version: string) => ({ via: "store" as const, version });
const play = (status: string, progress: number | null = null) => ({ via: "play" as const, versionCode: 42, status, progress });

function spyAssign() {
  const assign = vi.fn();
  vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign } as unknown as Location);
  return assign;
}

beforeEach(() => {
  vi.clearAllMocks();
  browserOpen.mockResolvedValue(undefined);
  bridge.startPlayUpdate.mockResolvedValue(null);
  bridge.openAppStorePage.mockResolvedValue(false);
  platform.isAndroid = false;
  platform.isIos = false;
  localStorage.clear();
});

describe("UpdateCard: store fallback", () => {
  it("Android: opens the Play Store via plain navigation, never @capacitor/browser", async () => {
    // Regression: routing the store link through @capacitor/browser (Chrome
    // Custom Tabs) crashed the app on-device.
    platform.isAndroid = true;
    const assign = spyAssign();
    render(<UpdateCard update={store("1.16.1")} />);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(PLAY_STORE_URL));
    expect(browserOpen).not.toHaveBeenCalled();
  });

  it("iOS: opens the App Store sheet natively", async () => {
    platform.isIos = true;
    bridge.openAppStorePage.mockResolvedValue(true);
    render(<UpdateCard update={store("1.16.1")} />);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(bridge.openAppStorePage).toHaveBeenCalled());
    expect(browserOpen).not.toHaveBeenCalled();
  });

  it("iOS: no dead link when the sheet can't open and no listing URL is known", async () => {
    platform.isIos = true;
    render(<UpdateCard update={store("1.16.1")} />);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(bridge.openAppStorePage).toHaveBeenCalled());
    expect(browserOpen).not.toHaveBeenCalled();
  });

  it("names the version", () => {
    render(<UpdateCard update={store("1.16.1")} />);
    expect(screen.getByText("Update available")).toBeInTheDocument();
    expect(screen.getByText("Version 1.16.1")).toBeInTheDocument();
  });

  it("dismissing hides it for that version, across launches", () => {
    const { unmount } = render(<UpdateCard update={store("1.16.1")} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Version 1.16.1")).toBeNull();
    expect(localStorage.getItem(UPDATE_DISMISSED_KEY)).toBe("1.16.1");
    unmount();
    render(<UpdateCard update={store("1.16.1")} />);
    expect(screen.queryByText("Version 1.16.1")).toBeNull();
  });

  it("comes back for a newer version", () => {
    localStorage.setItem(UPDATE_DISMISSED_KEY, "1.16.1");
    render(<UpdateCard update={store("1.17.0")} />);
    expect(screen.getByText("Version 1.17.0")).toBeInTheDocument();
  });
});

describe("UpdateCard: Play's flexible update", () => {
  it("shows nothing before a download: Play's own dialog is the prompt", () => {
    const { container } = render(<UpdateCard update={play("unknown")} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("follows the download", () => {
    render(<UpdateCard update={play("downloading", 0.42)} />);
    expect(screen.getByText("Downloading the update")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("asks for the restart once downloaded", () => {
    render(<UpdateCard update={play("downloaded")} />);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(bridge.completePlayUpdate).toHaveBeenCalled();
  });

  it("never offers the restart while a run records", () => {
    const { container } = render(<UpdateCard update={play("downloaded")} recorderOpen />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("UpdateRequired", () => {
  it("Android: opens Play's immediate update straight away", async () => {
    platform.isAndroid = true;
    render(<UpdateRequired />);
    await waitFor(() => expect(bridge.startPlayUpdate).toHaveBeenCalledWith(true));
  });

  it("Android: the button falls back to plain navigation when Play can't run its flow", async () => {
    platform.isAndroid = true;
    const assign = spyAssign();
    render(<UpdateRequired />);
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(PLAY_STORE_URL));
    expect(browserOpen).not.toHaveBeenCalled();
  });

  it("Android: no store page when Play's flow ran", async () => {
    platform.isAndroid = true;
    bridge.startPlayUpdate.mockResolvedValue("accepted");
    const assign = spyAssign();
    render(<UpdateRequired />);
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await waitFor(() => expect(bridge.startPlayUpdate).toHaveBeenCalledTimes(2));
    expect(assign).not.toHaveBeenCalled();
  });

  it("store doesn't have it yet: checks again instead of a listing that says Open", async () => {
    platform.isAndroid = true;
    const assign = spyAssign();
    const onRecheck = vi.fn().mockResolvedValue(undefined);
    render(<UpdateRequired pending onRecheck={onRecheck} />);
    expect(screen.getByText(/still on its way to Google Play/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(onRecheck).toHaveBeenCalled());
    expect(bridge.startPlayUpdate).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});
