import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// App Review 5.1.1(iv): on iOS a screen before a permission prompt may not say
// "Allow" or offer a way to put the prompt off. Play still needs accept/decline.
const native = vi.hoisted(() => ({ isIos: true }));
vi.mock("../native", async (orig) => ({
  ...(await orig<typeof import("../native")>()),
  get isIos() { return native.isIos; },
}));
vi.mock("../geo/background", () => ({ isBackgroundLocationAvailable: async () => false }));

const { BgLocationDisclosure } = await import("./BgLocationDisclosure");
const { HrSensorDisclosure } = await import("./HrSensorDisclosure");
const { SessionReminderDisclosure } = await import("./SessionReminderDisclosure");

const PRIMERS = [
  ["location", BgLocationDisclosure],
  ["bluetooth", HrSensorDisclosure],
  ["reminders", SessionReminderDisclosure],
] as const;

const buttonLabels = () => screen.getAllByRole("button").map(b => b.textContent?.trim());

afterEach(cleanup);

describe.each(PRIMERS)("%s permission primer", (_name, Primer) => {
  it("on iOS offers only Continue, which always leads to the prompt", () => {
    native.isIos = true;
    const onAccept = vi.fn();
    const onCancel = vi.fn();
    render(<Primer onAccept={onAccept} onCancel={onCancel} />);
    expect(buttonLabels()).toEqual(["Continue"]);
    expect(document.body.textContent).not.toMatch(/\bAllow\b/);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onAccept).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("elsewhere keeps the accept/decline pair Play's disclosure needs", () => {
    native.isIos = false;
    const onCancel = vi.fn();
    render(<Primer onAccept={vi.fn()} onCancel={onCancel} />);
    expect(buttonLabels()).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
