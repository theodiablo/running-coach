import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { StretchPlayer } from "./StretchPlayer";
import { ROUTINES } from "../stretch/routines";
import { stretchCue } from "../cues";
import { dismissTop } from "../utils/backDismiss";

vi.mock("../cues", () => ({ primeStretchCues: vi.fn(), stretchCue: vi.fn(), releaseCues: vi.fn() }));
vi.mock("../hooks/useKeepAwake", () => ({ useKeepAwake: vi.fn() }));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-03-10T18:00:00")); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.mocked(stretchCue).mockClear(); });

const setup = (over: Partial<React.ComponentProps<typeof StretchPlayer>> = {}) => {
  const props = {
    routine: ROUTINES.cooldown, voice: true, onVoiceChange: vi.fn(), weekCount: 2,
    onComplete: vi.fn(), onClose: vi.fn(), onFinish: vi.fn(), ...over,
  };
  render(<StretchPlayer {...props}/>);
  return props;
};
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe("StretchPlayer", () => {
  it("waits on the first stretch until started", () => {
    setup();
    expect(screen.getByRole("img", { name: "Wall calf stretch" })).toBeInTheDocument();
    expect(screen.getByText("Get ready")).toBeInTheDocument();
    expect(screen.getByText("Left side")).toBeInTheDocument();
    advance(10000);
    expect(screen.getByText("Get ready")).toBeInTheDocument();
  });

  it("counts the prep, then the hold, then switches sides", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(stretchCue).toHaveBeenCalledWith("step", "Wall calf stretch, left side", "en");
    advance(6000);
    expect(screen.getByText("Hold")).toBeInTheDocument();
    advance(30000);
    expect(screen.getByText("Switch sides")).toBeInTheDocument();
    expect(screen.getByText("Right side")).toBeInTheDocument();
    expect(stretchCue).toHaveBeenLastCalledWith("step", "Switch sides", "en");
  });

  it("stays silent apart from beeps with voice off", () => {
    setup({ voice: false });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(stretchCue).toHaveBeenCalledWith("step", undefined, "en");
  });

  it("logs the session once, at the end", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    advance(7 * 60 * 1000 + 1000);
    expect(p.onComplete).toHaveBeenCalledTimes(1);
    expect(p.onComplete).toHaveBeenCalledWith(420);
    expect(screen.getByText("Cool-down done")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(p.onFinish).toHaveBeenCalledTimes(1);
  });

  it("skipping past the last stretch finishes the routine", () => {
    const p = setup();
    for (let i = 0; i < 12; i++) fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(p.onComplete).toHaveBeenCalledTimes(1);
  });

  it("asks before leaving a routine under way, and back keeps it going", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    advance(8000);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByText("Stop this routine?")).toBeInTheDocument();
    act(() => { expect(dismissTop()).toBe(true); });
    expect(screen.queryByText("Stop this routine?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(p.onClose).toHaveBeenCalledTimes(1);
    expect(p.onComplete).not.toHaveBeenCalled();
  });

  it("closes without asking before it has started", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });
});
