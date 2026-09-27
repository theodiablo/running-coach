import { describe, it, expect } from "vitest";
import { RUNWALK_DEFAULT, runWalkConfig, runwalkRunSec } from "./runwalk";

const ladder = (runSec: number) =>
  ["BASE", "BUILD", "PEAK", "TAPER"].map(p => runwalkRunSec({ runSec, walkSec: 60 }, p));

describe("runWalkConfig", () => {
  it("defaults an unset pair to 3 min / 1 min", () => {
    expect(runWalkConfig(undefined)).toEqual(RUNWALK_DEFAULT);
    expect(runWalkConfig({})).toEqual(RUNWALK_DEFAULT);
  });

  it("keeps a configured pair", () => {
    expect(runWalkConfig({ runWalkRunSec: 90, runWalkWalkSec: 45 })).toEqual({ runSec: 90, walkSec: 45 });
  });

  // The pair rides the user-writable blob, so nonsense must never reach buildPlan.
  it("clamps and rounds a nonsense pair instead of trusting it", () => {
    expect(runWalkConfig({ runWalkRunSec: 99999, runWalkWalkSec: 0 }))
      .toEqual({ runSec: 600, walkSec: RUNWALK_DEFAULT.walkSec });
    expect(runWalkConfig({ runWalkRunSec: -5, runWalkWalkSec: 3 }))
      .toEqual({ runSec: RUNWALK_DEFAULT.runSec, walkSec: 15 });
    expect(runWalkConfig({ runWalkRunSec: 97, runWalkWalkSec: 62 })).toEqual({ runSec: 95, walkSec: 60 });
  });
});

describe("runwalkRunSec", () => {
  // The pre-setting plan ramped 1 / 2 / 3 min with the taper back at 2 — the
  // default must still reproduce it to the second.
  it("reproduces the original minute ladder at the default ceiling", () => {
    expect(ladder(180)).toEqual([60, 120, 180, 120]);
  });

  it("never proposes more than the runner's ceiling", () => {
    for (const cap of [30, 45, 60, 90, 120, 180, 240]) {
      const steps = ladder(cap);
      expect(Math.max(...steps)).toBe(cap);
      expect(steps.every(s => s <= cap)).toBe(true);
    }
  });

  it("ramps up to a sub-minute ceiling in 15 s steps, floored at 30 s", () => {
    expect(ladder(90)).toEqual([30, 60, 90, 60]);
    expect(ladder(45)).toEqual([30, 30, 45, 30]);
    expect(ladder(30)).toEqual([30, 30, 30, 30]);
  });
});
