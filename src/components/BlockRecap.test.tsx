import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BlockDoneCard, BlockRecap } from "./BlockRecap";
import type { BlockRecap as Recap } from "../utils/blockRecap";

afterEach(cleanup);

const recap = (over: Partial<Recap> = {}): Recap =>
  ({ from: "2026-08-17", to: "2026-10-03", sessionsDone: 18, sessionsPlanned: 22, km: 142.5, longestKm: 17, runs: 20, easyPace: null, ...over });

describe("BlockRecap", () => {
  it("shows the three numbers and no pace line when the log cannot support one", () => {
    render(<BlockRecap recap={recap()}/>);
    expect(screen.getByText("18 of 22")).toBeInTheDocument();
    expect(screen.getByText("142.5 km")).toBeInTheDocument();
    expect(screen.getByText("17 km")).toBeInTheDocument();
    expect(screen.queryByText("Easy pace")).toBeNull();
  });

  it("claims the same heart rate only when the trend was normalised to one", () => {
    render(<BlockRecap recap={recap({ easyPace: { from: 378, to: 342, atHr: 145 } })}/>);
    expect(screen.getByText("6:18 → 5:42 /km")).toBeInTheDocument();
    expect(screen.getByText(/same heart rate \(about 145 bpm\)/)).toBeInTheDocument();
  });

  it("without a heart rate it is a plain median, with no same-effort claim", () => {
    render(<BlockRecap recap={recap({ easyPace: { from: 360, to: 340, atHr: null } })}/>);
    expect(screen.getByText("6:00 → 5:40 /km")).toBeInTheDocument();
    expect(screen.getByText(/Median of your easy runs/)).toBeInTheDocument();
    expect(screen.queryByText(/heart rate/)).toBeNull();
  });
});

describe("BlockDoneCard", () => {
  it("names the block", () => {
    render(<BlockDoneCard block={2} recap={recap()}/>);
    expect(screen.getByText("Block 2 done")).toBeInTheDocument();
    expect(screen.getByText("18 of 22")).toBeInTheDocument();
  });
});
