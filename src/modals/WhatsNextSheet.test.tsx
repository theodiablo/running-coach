import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { WhatsNextSheet } from "./WhatsNextSheet";
import { track } from "../telemetry";
import { dismissTop } from "../utils/backDismiss";
import { hydrateCatalogue } from "../utils/races";
import type { BlockRecap } from "../utils/blockRecap";
import type { Participation, Run } from "../types";

vi.mock("../telemetry", () => ({ track: vi.fn() }));
vi.useFakeTimers({ shouldAdvanceTime: true });
vi.setSystemTime(new Date("2026-10-20T09:00:00"));

afterEach(() => { cleanup(); vi.clearAllMocks(); hydrateCatalogue([]); });

const recap: BlockRecap = { from: "2026-08-17", to: "2026-10-03", sessionsDone: 18, sessionsPlanned: 22, km: 142.5, longestKm: 17, runs: 20, easyPace: null };

const mount = (over: Record<string, unknown> = {}) => {
  const onAnswer = vi.fn();
  render(<WhatsNextSheet variant="afterRace" kmRef={10} recap={recap} blockRunner={false} participations={[]} runs={[]}
    onAnswer={onAnswer} {...(over as object)}/>);
  return onAnswer;
};

// The goal cards in the order the sheet puts them.
const goalTitles = () => screen.getAllByText(/^(Pick my next race|Try a real race|Keep improving|A lighter plan)$/).map(e => e.textContent);

describe("WhatsNextSheet", () => {
  it("recaps the block, then asks how the runner feels, then offers goals", () => {
    mount();
    expect(track).toHaveBeenCalledWith("whats_next_shown", { variant: "afterRace" });
    expect(screen.getByText("The training that got you here")).toBeInTheDocument();
    expect(screen.getByText("18 of 22")).toBeInTheDocument();
    expect(screen.getByText("142.5 km")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("How are you feeling about running?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Fired up/ }));
    expect(screen.getByText("Where to from here?")).toBeInTheDocument();
  });

  it.each([
    ["Fired up", ["Pick my next race", "Keep improving"]],
    ["Steady", ["Keep improving", "Pick my next race"]],
    ["Need a breather", ["A lighter plan", "Keep improving"]],
  ])("orders the goals for %s", (feeling, order) => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(feeling) }));
    expect(goalTitles()).toEqual(order);
  });

  it("skips the recap when there is nothing to recap", () => {
    mount({ recap: null });
    expect(screen.getByText("How are you feeling about running?")).toBeInTheDocument();
  });

  it("a runner on blocks of their own is offered a real race, not 'my next race'", () => {
    mount({ blockRunner: true });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Fired up/ }));
    expect(goalTitles()).toEqual(["Try a real race", "Keep improving"]);
  });

  it("passes the feeling along with the answer", () => {
    const onAnswer = mount();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Need a breather/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start the lighter plan" }));
    expect(onAnswer).toHaveBeenCalledWith({ choice: "lighter" }, "breather");
  });

  it("Keep improving offers faster at each distance with the best effort, further and healthy", () => {
    const onAnswer = mount({ runs: [{ id: "a", date: "2026-10-01", type: "EASY", km: 10, durationSec: 3000 }] as Run[] });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Steady/ }));
    expect(screen.getByText("Your best: 50:00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Faster at 10K/ }));
    expect(onAnswer).toHaveBeenLastCalledWith({ choice: "improve", target: "faster", distanceKm: 10 }, "steady");
    fireEvent.click(screen.getByRole("button", { name: /Run further/ }));
    expect(onAnswer).toHaveBeenLastCalledWith({ choice: "improve", target: "further", distanceKm: 10 }, "steady");
    fireEvent.click(screen.getByRole("button", { name: /Stay healthy and consistent/ }));
    expect(onAnswer).toHaveBeenLastCalledWith({ choice: "improve", target: "healthy", distanceKm: 10 }, "steady");
  });

  it("leads with a wishlisted race that is far enough away", () => {
    const part = { editionId: "ed1", status: "wishlist", label: "Valencia 10K", raceDate: "2026-12-06", distanceKm: 10, raceId: "r" } as Participation;
    const onAnswer = mount({ participations: [part] });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Fired up/ }));
    expect(screen.getByText("On your list")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Train for it" }));
    expect(onAnswer).toHaveBeenCalledWith(
      { choice: "race", edition: expect.objectContaining({ name: "Valencia 10K", edition: expect.objectContaining({ id: "ed1", date: "2026-12-06" }) }) }, "fired");
  });

  it("suggests catalogue races when nothing is on the list", () => {
    hydrateCatalogue([{ id: "r1", name: "City 10K", editions: [{ id: "e1", date: "2026-12-20", distanceKm: 10 }] }] as never);
    const onAnswer = mount();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Fired up/ }));
    expect(screen.getByText("Races that fit")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Train for it" }));
    expect(onAnswer.mock.calls[0][0]).toMatchObject({ choice: "race", edition: { name: "City 10K" } });
  });

  it("'Not now' is an answer, and so is closing it with back", () => {
    const onAnswer = mount();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onAnswer).toHaveBeenLastCalledWith({ choice: "later" }, null);
    dismissTop();
    expect(onAnswer).toHaveBeenCalledTimes(2);
  });

  describe("the race-first variant", () => {
    it("skips the recap and the question, and puts races before Keep improving", () => {
      const onAnswer = mount({ variant: "raceFirst", label: "Valencia 10K", recap: null });
      expect(track).toHaveBeenCalledWith("whats_next_shown", { variant: "raceFirst" });
      expect(screen.getByText("Valencia 10K, done!")).toBeInTheDocument();
      expect(screen.queryByText("How are you feeling about running?")).toBeNull();
      expect(goalTitles()).toEqual(["Pick my next race", "Keep improving"]);
      fireEvent.click(screen.getByRole("button", { name: "Browse all races" }));
      expect(onAnswer).toHaveBeenCalledWith({ choice: "race", edition: null }, null);
    });
  });
});
