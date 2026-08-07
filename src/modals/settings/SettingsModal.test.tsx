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

// The hub is a menu: nothing configurable on the root besides sign out, one
// tap to each page, and back/Escape pops exactly one level (the LIFO dismiss
// stack).
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

  it("shows sign out at the root, not inside Account", () => {
    const onSignOut = vi.fn();
    render(<SettingsModal {...baseProps} onSignOut={onSignOut} />);
    fireEvent.click(screen.getByText("Sign out"));
    expect(onSignOut).toHaveBeenCalledTimes(1);

    // Opening Account doesn't add a second sign-out control to the page.
    fireEvent.click(screen.getByText("Account"));
    expect(screen.getAllByText("Sign out")).toHaveLength(1);
  });

  it("hides sign out when no handler is provided", () => {
    render(<SettingsModal {...baseProps} />);
    expect(screen.queryByText("Sign out")).toBeNull();
  });

  it("opens Training profile with the HR fields and coach memory", () => {
    render(<SettingsModal {...baseProps} />);
    fireEvent.click(screen.getByText("Training profile"));
    expect(screen.getByText("Heart rate")).toBeInTheDocument();
    expect(screen.getByText("Coach memory")).toBeInTheDocument();
    expect(screen.getByText("Coach identity")).toBeInTheDocument();
  });

  it("saves a coach mark on tap and marks it selected", () => {
    const saveSettings = vi.fn();
    render(<SettingsModal {...baseProps} saveSettings={saveSettings} />);
    fireEvent.click(screen.getByText("Training profile"));
    // Default mark is selected without any stored setting.
    expect(screen.getByRole("radio", { name: "Pulse" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Stopwatch" }));
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ coachAvatar: "stopwatch" }));
  });

  it("commits a trimmed coach name on blur", () => {
    const saveSettings = vi.fn();
    render(<SettingsModal {...baseProps} saveSettings={saveSettings} />);
    fireEvent.click(screen.getByText("Training profile"));
    const input = screen.getByLabelText("Coach name");
    fireEvent.change(input, { target: { value: "  Ava  " } });
    fireEvent.blur(input);
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ coachName: "Ava" }));
  });

  it("drops the coach name from settings when cleared", () => {
    const saveSettings = vi.fn();
    render(<SettingsModal {...baseProps} settings={{ coachName: "Ava" } as SettingsState} saveSettings={saveSettings} />);
    fireEvent.click(screen.getByText("Training profile"));
    const input = screen.getByLabelText("Coach name");
    expect(input).toHaveValue("Ava");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ coachName: undefined }));
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
