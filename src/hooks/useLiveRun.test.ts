import { describe, it, expect } from "vitest";
import { isActive } from "./useLiveRun";
import type { LiveRunRow } from "../live/publisher";

// The staleness rule the banner and the watch modal both hang off. It is
// deliberately generous: the recorder only publishes when a GPS fix lands, so a
// runner standing at a crossing goes quiet for minutes without anything being
// wrong. Only "ended" or genuinely ancient rows stop counting as live.

const NOW = 1_700_000_000_000;
const row = (over: Partial<LiveRunRow> = {}): LiveRunRow => ({
  user_id: "u1",
  status: "live",
  started_at: new Date(NOW - 600000).toISOString(),
  updated_at: new Date(NOW - 60000).toISOString(),
  points: [],
  stats: {},
  ...over,
});

describe("isActive", () => {
  it("is false without a row", () => {
    expect(isActive(null, NOW)).toBe(false);
  });

  it("is true for a recently updated run", () => {
    expect(isActive(row(), NOW)).toBe(true);
  });

  it("stays true through a long quiet stretch", () => {
    // Ten minutes of no fixes is a tunnel or a coffee stop, not a finished run.
    expect(isActive(row({ updated_at: new Date(NOW - 600000).toISOString() }), NOW)).toBe(true);
  });

  it("is true while paused", () => {
    expect(isActive(row({ status: "paused" }), NOW)).toBe(true);
  });

  it("is false once the run reports it ended", () => {
    expect(isActive(row({ status: "ended" }), NOW)).toBe(false);
  });

  it("is false for a row left behind by a killed app", () => {
    expect(isActive(row({ updated_at: new Date(NOW - 7 * 3600 * 1000).toISOString() }), NOW)).toBe(false);
  });

  it("is false for an unparseable timestamp rather than assuming live", () => {
    expect(isActive(row({ updated_at: "not-a-date" }), NOW)).toBe(false);
  });
});
