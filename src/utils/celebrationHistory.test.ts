// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { celebrate } from "./celebrationHistory";
import type { Run } from "../types";

const at = new Date("2026-09-16T12:00:00");
const runs: Run[] = Array.from({ length: 6 }, (_, i) => ({ id: "p" + i, date: "2026-09-0" + (i + 1), type: "EASY", km: 6, durationSec: 2160 }));
const run: Run = { date: "2026-09-16", type: "EASY", km: 6, durationSec: 2160 };

beforeEach(() => localStorage.clear());

describe("celebrate", () => {
  it("doesn't repeat a headline across several runs in a row", () => {
    const seen = Array.from({ length: 8 }, () => celebrate({ run, runs, at })!.headline);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("still works when storage is unusable", () => {
    localStorage.setItem("rc_celebration_recent", "{not json");
    expect(celebrate({ run, runs, at })?.headline).toMatch(/^celebration\.head\./);
  });
});
