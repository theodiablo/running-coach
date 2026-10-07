import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { StretchSheet } from "./StretchSheet";
import { dismissTop } from "../utils/backDismiss";

vi.mock("../cues", () => ({ primeStretchCues: vi.fn(), stretchCue: vi.fn(), releaseCues: vi.fn() }));
vi.mock("../hooks/useKeepAwake", () => ({ useKeepAwake: vi.fn() }));
afterEach(cleanup);

const setup = (target: React.ComponentProps<typeof StretchSheet>["target"]) => {
  const props = { target, weekCount: 1, voice: true, onVoiceChange: vi.fn(), onComplete: vi.fn(), onClose: vi.fn() };
  render(<StretchSheet {...props}/>);
  return props;
};

describe("StretchSheet", () => {
  it("lists the four routines when opened on demand", () => {
    setup(null);
    for (const name of ["Cool-down", "Recovery mobility", "Warm-up drills", "Rest-day stretch"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.getByText(/1 session this week/)).toBeInTheDocument();
  });

  it("opens a Home suggestion straight on its routine, saying why", () => {
    setup({ routine: "cooldown", focus: "hills", km: 12 });
    expect(screen.getByText("Cool-down")).toBeInTheDocument();
    expect(screen.getByText("A hilly 12.0 km, so the calf stretches get 45 s.")).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Wall calf stretch");
    expect(rows[0]).toHaveTextContent("45 s each side");
  });

  it("shows the rest-day rounds and the closing stretch apart", () => {
    setup(null);
    fireEvent.click(screen.getByText("Rest-day stretch"));
    expect(screen.getByText("× 2 rounds")).toBeInTheDocument();
    expect(screen.getByText("Then")).toBeInTheDocument();
  });

  it("back from a routine picked in the list returns to the list", () => {
    const p = setup(null);
    fireEvent.click(screen.getByText("Warm-up drills"));
    expect(screen.getByText("Leg swings")).toBeInTheDocument();
    act(() => { dismissTop(); });
    expect(p.onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Rest-day stretch")).toBeInTheDocument();
    act(() => { dismissTop(); });
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it("starts the player and logs the routine it ran", () => {
    setup({ routine: "recovery", km: 18, race: false });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getByText("Get ready")).toBeInTheDocument();
    expect(screen.getAllByText("Cat-cow").length).toBeGreaterThan(0);
  });

  it("previews a move from the routine, both sides, then the next one", () => {
    setup({ routine: "cooldown", focus: "standard", km: 8 });
    fireEvent.click(screen.getByText("Wall calf stretch"));
    expect(screen.getByRole("heading", { name: "Wall calf stretch" })).toBeInTheDocument();
    expect(screen.getByText("Back leg straight, heel down")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Left side" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Right side" }));
    expect(screen.getByRole("button", { name: "Right side" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByRole("heading", { name: "Bent-knee calf stretch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Left side" })).toHaveAttribute("aria-pressed", "true");
  });

  it("back from a preview returns to the routine, not the list", () => {
    const p = setup(null);
    fireEvent.click(screen.getByText("Warm-up drills"));
    fireEvent.click(screen.getByText("Leg swings"));
    act(() => { dismissTop(); });
    expect(screen.queryByRole("heading", { name: "Leg swings" })).not.toBeInTheDocument();
    expect(screen.getByText("Leg swings")).toBeInTheDocument();
    expect(p.onClose).not.toHaveBeenCalled();
  });
});
