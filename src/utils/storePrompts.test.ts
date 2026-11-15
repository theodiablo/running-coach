import { describe, it, expect } from "vitest";
import {
  reviewPromptDue, playPromptDue, nextPlayPromptRecord,
  REVIEW_MIN_RUNS, REVIEW_MIN_TENURE_DAYS, REVIEW_GAP_DAYS, PLAY_REMIND_DAYS,
} from "./storePrompts";
import type { Run } from "../types";

const TODAY = "2026-06-30";
const daysAgo = (n: number) => {
  const d = new Date(TODAY + "T00:00:00");
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const run = (ago: number, type = "EASY"): Run => ({ date: daysAgo(ago), type, km: 5 } as Run);
// A regular runner: started a month ago, three runs in the last week.
const regular = [run(0), run(3), run(6), run(12), run(20), run(30)];

describe("reviewPromptDue", () => {
  it("asks a runner who plainly runs with the app", () => {
    expect(regular.length).toBe(REVIEW_MIN_RUNS);
    expect(reviewPromptDue({ runs: regular, today: TODAY })).toBe(true);
  });

  it("waits for enough runs", () => {
    expect(reviewPromptDue({ runs: regular.slice(0, -1), today: TODAY })).toBe(false);
  });

  it("waits until the app has been in use for a while", () => {
    const burst = Array.from({ length: 8 }, (_, i) => run(i));
    expect(REVIEW_MIN_TENURE_DAYS).toBeGreaterThan(7);
    expect(reviewPromptDue({ runs: burst, today: TODAY })).toBe(false);
  });

  it("skips someone coming back after a long break", () => {
    const lapsed = [run(0), run(40), run(45), run(50), run(55), run(60)];
    expect(reviewPromptDue({ runs: lapsed, today: TODAY })).toBe(false);
  });

  it("doesn't count cross-training as running with the app", () => {
    const bike = [run(0), run(3, "OTHER"), run(6), run(12), run(20), run(30)];
    expect(reviewPromptDue({ runs: bike, today: TODAY })).toBe(false);
  });

  it("leaves a long gap between asks", () => {
    expect(reviewPromptDue({ runs: regular, asks: [daysAgo(REVIEW_GAP_DAYS - 1)], today: TODAY })).toBe(false);
    expect(reviewPromptDue({ runs: regular, asks: [daysAgo(400), daysAgo(REVIEW_GAP_DAYS)], today: TODAY })).toBe(true);
  });
});

describe("playPromptDue", () => {
  it("offers each new version once, then one reminder a week later", () => {
    expect(playPromptDue(42, null, TODAY)).toBe(true);
    const first = nextPlayPromptRecord(42, null, daysAgo(PLAY_REMIND_DAYS - 1));
    expect(playPromptDue(42, first, TODAY)).toBe(false);
    const aged = nextPlayPromptRecord(42, null, daysAgo(PLAY_REMIND_DAYS));
    expect(playPromptDue(42, aged, TODAY)).toBe(true);
    const second = nextPlayPromptRecord(42, aged, TODAY);
    expect(second.asks).toBe(2);
    expect(playPromptDue(42, { ...second, at: daysAgo(60) }, TODAY)).toBe(false);
  });

  it("starts over for a newer version", () => {
    const spent = { code: 41, asks: 2, at: TODAY };
    expect(playPromptDue(42, spent, TODAY)).toBe(true);
    expect(nextPlayPromptRecord(42, spent, TODAY).asks).toBe(1);
  });
});
