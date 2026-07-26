import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { SettingsModal } from "../SettingsModal";
import { dismissTop } from "../../utils/backDismiss";
import type { SettingsState, UserContextState } from "../../types";

afterEach(cleanup);

const baseProps = {
  settings: {} as SettingsState,
  saveSettings: () => {},
  userContext: {} as UserContextState,
  saveUserContext: () => {},
  onBackup: () => {},
  onRestore: () => {},
  onClose: () => {},
};

// The hub is a menu: nothing configurable on the root, one tap to each page,
// and back/Escape pops exactly one level (the LIFO dismiss stack).
describe("SettingsModal hub", () => {
  it("shows only the three menu rows at the root", () => {
    render(<SettingsModal {...baseProps} />);
    expect(screen.getByText("Account")).toBeInTheDocument();
    expect(screen.getByText("Integrations")).toBeInTheDocument();
    expect(screen.getByText("Training profile")).toBeInTheDocument();
    // No controls from the old single-page settings.
    expect(screen.queryByText("Your name")).toBeNull();
    expect(screen.queryByText("Connections & sync")).toBeNull();
  });

  it("opens Training profile with the HR fields and coach memory", () => {
    render(<SettingsModal {...baseProps} />);
    fireEvent.click(screen.getByText("Training profile"));
    expect(screen.getByText("Heart rate")).toBeInTheDocument();
    expect(screen.getByText("Coach memory")).toBeInTheDocument();
  });

  it("opens Integrations with the connections card and the vendor guides", () => {
    render(<SettingsModal {...baseProps} />);
    fireEvent.click(screen.getByText("Integrations"));
    expect(screen.getByText("Connections & sync")).toBeInTheDocument();
    expect(screen.getByText("Strava, Zepp & other apps")).toBeInTheDocument();
  });

  it("dismisses the sub-page first, then the hub", () => {
    const onClose = vi.fn();
    render(<SettingsModal {...baseProps} onClose={onClose} />);
    fireEvent.click(screen.getByText("Account"));
    expect(screen.getByText("Your name")).toBeInTheDocument();

    act(() => { dismissTop(); }); // back / Escape
    expect(screen.queryByText("Your name")).toBeNull();
    expect(screen.getByText("Account")).toBeInTheDocument(); // back at the hub
    expect(onClose).not.toHaveBeenCalled();

    act(() => { dismissTop(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns to the hub via the back button", () => {
    render(<SettingsModal {...baseProps} />);
    fireEvent.click(screen.getByText("Integrations"));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByText("Connections & sync")).toBeNull();
    expect(screen.getByText("Training profile")).toBeInTheDocument();
  });
});
