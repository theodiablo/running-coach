import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ShareCardSheet } from "./ShareCardSheet";
import { dismissTop } from "../utils/backDismiss";
import type { Run, SettingsState } from "../types";

vi.mock("../share/fonts", () => ({ loadCardFonts: () => Promise.resolve() }));

beforeAll(() => {
  // jsdom has no canvas: the builder must still render (the preview just stays blank).
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(cleanup);

const settings = { raceDate: "", goalSec: "", distanceKm: "", raceElevation: 0, name: "" } as unknown as SettingsState;
const today = new Date();
const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

const setup = (run: Run, runs: Run[] = []) => {
  const onClose = vi.fn();
  render(<ShareCardSheet run={run} runs={runs} plan={null} settings={settings} participations={[]} points={null} onClose={onClose} />);
  return onClose;
};

describe("ShareCardSheet", () => {
  it("pre-selects Number for a personal best and says so in the preview's label", () => {
    const run: Run = { id: "r", date: ymd, type: "EASY", km: 10.4, durationSec: 3100, bestEfforts: { "10k": 2991 } };
    setup(run, [{ id: "p", date: "2026-01-01", type: "EASY", km: 10, durationSec: 3029, bestEfforts: { "10k": 3029 } }]);
    expect(screen.getByRole("button", { name: "Number" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("img").getAttribute("aria-label"))
      .toMatch(/^Card preview: Number, New personal best, 10K 49:51, 38 s quicker than my last best, Distance 10\.4 km/);
  });

  it("offers no Route chip and no route switches for a run without a trace", () => {
    setup({ id: "r", date: ymd, type: "EASY", km: 5, durationSec: 1800 });
    expect(screen.queryByRole("button", { name: "Route" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show the route" })).toBeNull();
  });

  it("hides the pace switch for an indoor session", () => {
    setup({ id: "i", date: ymd, type: "OTHER", km: 0, durationSec: 2700, activity: "bike" });
    expect(screen.queryByRole("button", { name: "Show pace" })).toBeNull();
  });

  it("drops pace from the preview when switched off", () => {
    setup({ id: "r", date: ymd, type: "EASY", km: 5, durationSec: 1800 });
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Pace");
    fireEvent.click(screen.getByRole("button", { name: "Show pace" }));
    expect(screen.getByRole("button", { name: "Show pace" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("img").getAttribute("aria-label")).not.toContain("Pace");
  });

  it("closes on Android back / Escape via the dismiss registry", () => {
    const onClose = setup({ id: "r", date: ymd, type: "EASY", km: 5, durationSec: 1800 });
    expect(dismissTop()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
