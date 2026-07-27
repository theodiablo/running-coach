import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RunAchievementSheet } from "./RunAchievementSheet";
import { runAchievements } from "../utils/bestEfforts";
import type { EffortRank } from "../utils/bestEfforts";
import type { Run } from "../types";

afterEach(cleanup);

const run: Run = { id: "new", date: "2026-07-20", km: 10.2, durationSec: 3060 };

const effort = (over: Partial<EffortRank> = {}): EffortRank => ({
  key: "5k", km: 5, sec: 1400, rank: 1, total: 4,
  previousBest: { sec: 1450, date: "2026-06-01" }, gainSec: 50, ...over,
});

const show = (efforts: EffortRank[], onClose = () => {}) =>
  render(<RunAchievementSheet run={run} efforts={efforts} onClose={onClose} />);

describe("RunAchievementSheet", () => {
  it("leads with the personal best and how much it beat the old one by", () => {
    show([effort()]);
    expect(screen.getByText(/new personal best/i)).toBeInTheDocument();
    expect(screen.getByText(/fastest ever/i)).toBeInTheDocument();
    expect(screen.getByText("23:20")).toBeInTheDocument();
    expect(screen.getByText(/0:50 faster than before/i)).toBeInTheDocument();
  });

  it("calls a first-ever effort what it is rather than a personal best", () => {
    show([effort({ rank: 1, total: 1, previousBest: null, gainSec: null })]);
    expect(screen.getByText(/first one on the board/i)).toBeInTheDocument();
    expect(screen.getByText(/first on record/i)).toBeInTheDocument();
    expect(screen.queryByText(/fastest ever/i)).not.toBeInTheDocument();
  });

  it("shows a runner-up rank with the standing best to chase", () => {
    show([effort({ rank: 2, total: 6, gainSec: -30 })]);
    expect(screen.getByText(/that was quick/i)).toBeInTheDocument();
    expect(screen.getByText(/2nd fastest/i)).toBeInTheDocument();
    expect(screen.getByText(/best 24:10/i)).toBeInTheDocument();
    // A slower run must not be dressed up as an improvement.
    expect(screen.queryByText(/faster than before/i)).not.toBeInTheDocument();
  });

  it("summarises the run itself so the numbers have context", () => {
    show([effort()]);
    expect(screen.getByText(/10\.2 km · 51:00 · 5:00\/km/)).toBeInTheDocument();
  });

  it("lists every ranked distance", () => {
    show([effort({ key: "10k", km: 10, sec: 3000 }), effort({ key: "5k", km: 5, rank: 3, total: 9 })]);
    expect(screen.getByText("10K")).toBeInTheDocument();
    expect(screen.getByText("5K")).toBeInTheDocument();
    expect(screen.getByText(/3rd fastest/i)).toBeInTheDocument();
  });

  it("closes on the dismiss button", () => {
    let closed = false;
    show([effort()], () => { closed = true; });
    fireEvent.click(screen.getByRole("button", { name: /nice/i }));
    expect(closed).toBe(true);
  });

  it("renders what runAchievements actually produces", () => {
    // Guards the contract between the ranking helper and this sheet: a shape
    // change in EffortRank must not silently render blank rows.
    const target: Run = { id: "new", date: "2026-07-20", km: 5, durationSec: 1400 };
    const history: Run[] = [target, { id: "old", date: "2026-06-01", km: 5, durationSec: 1450 }];
    const efforts = runAchievements(target, history);
    expect(efforts).toHaveLength(1);
    show(efforts);
    expect(screen.getByText(/fastest ever/i)).toBeInTheDocument();
    expect(screen.getByText("23:20")).toBeInTheDocument();
  });
});
