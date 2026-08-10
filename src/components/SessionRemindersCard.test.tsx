import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SESSION_NOTIF_AUTH_KEY, SESSION_NOTIF_DISCLOSED_KEY } from "../constants";
import type { Plan, SettingsState } from "../types";

vi.mock("../native", () => ({ isNative: true, isAndroid: true, isIos: false, platform: "android" }));

const requestReminderPermission = vi.fn(async () => true);
vi.mock("../notify/sessionReminders", () => ({
  hasReminderGrant: () => localStorage.getItem(SESSION_NOTIF_AUTH_KEY) === "1",
  refreshReminderGrant: async () => localStorage.getItem(SESSION_NOTIF_AUTH_KEY) === "1",
  requestReminderPermission: (...a: unknown[]) => requestReminderPermission(...a as []),
}));

const { SessionRemindersCard } = await import("./SessionRemindersCard");

afterEach(cleanup);
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

const plan = {weeks: [{weekNumber: 1, startDate: "2026-03-09", phase: "base", sessions: [
  {id: "a", date: "2026-03-12", type: "EASY", desc: "Easy run 5km", km: 5, pace: 360},
]}]} as unknown as Plan;

const renderCard = (settings: Partial<SettingsState>) => {
  const saveSettings = vi.fn();
  render(<SessionRemindersCard settings={settings as SettingsState} saveSettings={saveSettings} plan={plan}/>);
  return saveSettings;
};

describe("turning reminders off", () => {
  it("is one tap, and writes the preference off", () => {
    localStorage.setItem(SESSION_NOTIF_AUTH_KEY, "1");
    const saveSettings = renderCard({sessionReminders: true});

    const toggle = screen.getByRole("checkbox", {name: /Remind me about sessions/i});
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);

    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({sessionReminders: false}));
  });

  it("does not re-prompt for permission on the way out", () => {
    localStorage.setItem(SESSION_NOTIF_AUTH_KEY, "1");
    renderCard({sessionReminders: true});
    fireEvent.click(screen.getByRole("checkbox", {name: /Remind me about sessions/i}));
    expect(requestReminderPermission).not.toHaveBeenCalled();
  });

  it("hides the timing controls once off", () => {
    renderCard({sessionReminders: false});
    expect(screen.queryByLabelText("Remind me at")).toBeNull();
  });
});

describe("turning reminders on", () => {
  it("shows the disclosure before any OS prompt, the first time", () => {
    const saveSettings = renderCard({sessionReminders: false});
    fireEvent.click(screen.getByRole("checkbox", {name: /Remind me about sessions/i}));

    expect(screen.getByText("Running Coach can send you a", {exact: false})).toBeInTheDocument();
    // Nothing enabled and nothing prompted until the runner accepts.
    expect(requestReminderPermission).not.toHaveBeenCalled();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("declining the disclosure leaves reminders off", () => {
    const saveSettings = renderCard({sessionReminders: false});
    fireEvent.click(screen.getByRole("checkbox", {name: /Remind me about sessions/i}));
    fireEvent.click(screen.getByRole("button", {name: "Not now"}));

    expect(saveSettings).not.toHaveBeenCalled();
    expect(localStorage.getItem(SESSION_NOTIF_DISCLOSED_KEY)).toBeNull();
  });

  it("enables only after the grant comes back", async () => {
    const saveSettings = renderCard({sessionReminders: false});
    fireEvent.click(screen.getByRole("checkbox", {name: /Remind me about sessions/i}));
    fireEvent.click(screen.getByRole("button", {name: "Turn on reminders"}));

    await vi.waitFor(() => expect(requestReminderPermission).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({sessionReminders: true})));
  });

  it("stays off and explains itself when the OS grant is refused", async () => {
    requestReminderPermission.mockResolvedValueOnce(false);
    const saveSettings = renderCard({sessionReminders: false});
    fireEvent.click(screen.getByRole("checkbox", {name: /Remind me about sessions/i}));
    fireEvent.click(screen.getByRole("button", {name: "Turn on reminders"}));

    await vi.waitFor(() => expect(screen.getByText(/Notifications are turned off/)).toBeInTheDocument());
    expect(saveSettings).not.toHaveBeenCalled();
  });
});

// The synced preference arrives true on a freshly installed second phone where
// no OS grant exists. Before the fix the toggle read "on" and offered only
// "turn off", so the permission prompt was unreachable and the card promised a
// next reminder that could never fire.
describe("a second device with the preference already synced on", () => {
  it("shows the toggle as off, because nothing is actually scheduled here", () => {
    renderCard({sessionReminders: true});
    expect(screen.getByRole("checkbox", {name: /Remind me about sessions/i})).not.toBeChecked();
  });

  it("does not claim a next reminder", () => {
    renderCard({sessionReminders: true});
    expect(screen.queryByText(/Next reminder/)).toBeNull();
  });

  it("can still reach the permission prompt", async () => {
    localStorage.setItem(SESSION_NOTIF_DISCLOSED_KEY, "1");
    renderCard({sessionReminders: true});
    fireEvent.click(screen.getByRole("checkbox", {name: /Remind me about sessions/i}));
    await vi.waitFor(() => expect(requestReminderPermission).toHaveBeenCalled());
  });

  it("shows as on once this device is granted too", async () => {
    localStorage.setItem(SESSION_NOTIF_AUTH_KEY, "1");
    renderCard({sessionReminders: true});
    await vi.waitFor(() =>
      expect(screen.getByRole("checkbox", {name: /Remind me about sessions/i})).toBeChecked());
  });
});

describe("timing controls", () => {
  beforeEach(() => localStorage.setItem(SESSION_NOTIF_AUTH_KEY, "1"));

  it("defaults to the evening before at 18:00", () => {
    renderCard({sessionReminders: true});
    expect(screen.getByLabelText("Remind me at")).toHaveValue("18:00");
    expect(screen.getByLabelText("When")).toHaveValue("1");
  });

  it("saves a changed time", () => {
    const saveSettings = renderCard({sessionReminders: true});
    fireEvent.change(screen.getByLabelText("Remind me at"), {target: {value: "07:30"}});
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({reminderTime: "07:30"}));
  });

  it("saves a switch to the morning of the session", () => {
    const saveSettings = renderCard({sessionReminders: true});
    fireEvent.change(screen.getByLabelText("When"), {target: {value: "0"}});
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({reminderLeadDays: 0}));
  });
});
