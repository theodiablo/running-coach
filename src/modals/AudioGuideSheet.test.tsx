import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "../i18n";
import { AudioGuideSheet } from "./AudioGuideSheet";
import { DEFAULT_AUDIO } from "../utils/callout";

afterEach(cleanup);

const renderSheet = (on: boolean) => render(
  <AudioGuideSheet on={on} prefs={DEFAULT_AUDIO} pace={300} hr={null} hasHrSensor={false} sample="On pace."
    onToggle={vi.fn()} onPrefs={vi.fn()} onEditWorkout={vi.fn()} onHear={vi.fn()} onClose={vi.fn()} />);

describe("AudioGuideSheet", () => {
  it.each([true, false])("flags the feature as beta and asks for feedback (on=%s)", (on) => {
    renderSheet(on);
    expect(screen.getByRole("dialog").querySelector("h3")?.textContent).toContain("Beta");
    expect(screen.getByText(/still being tested.*Feedback button/)).toBeTruthy();
  });
});
