import { describe, it, expect } from "vitest";
import { idleEdgesSec, trimmedMovingSec } from "./idleEdges";
import type { TrackPointOrGap } from "./geo";

const T0 = 1_700_000_000_000;
const M_PER_DEG = 111_195;

// A track built leg by leg: `stand(sec)` adds one jitter fix `sec` later,
// `run(sec, mps)` adds a fix every 2s heading north.
function track() {
  const pts: TrackPointOrGap[] = [];
  let lat = 43, t = T0;
  const push = () => pts.push([lat, -2, t, null]);
  push();
  const api = {
    pts,
    stand(sec: number) { t += sec * 1000; lat += 6 / M_PER_DEG; push(); return api; },
    run(sec: number, mps = 3) { for (let s = 2; s <= sec; s += 2) { t += 2000; lat += (2 * mps) / M_PER_DEG; push(); } return api; },
    gap() { pts.push(null); return api; },
    get t() { return t; },
  };
  return api;
}

describe("idleEdgesSec", () => {
  it("trims standing at the start line and after the finish", () => {
    const tr = track().stand(200).run(3600).stand(30).stand(240);
    const startedAt = T0 - 90_000, stoppedAt = tr.t + 20_000;
    const { leadSec, tailSec } = idleEdgesSec(tr.pts, startedAt, stoppedAt);
    expect(leadSec).toBe(290);           // 90s before the first fix + 200s standing
    expect(tailSec).toBe(30 + 240 + 20); // standing after the finish, until Stop
  });

  it("trims nothing when the run is moving from its first fix to its last", () => {
    const tr = track().run(1800);
    expect(idleEdgesSec(tr.pts, T0 - 60_000, tr.t + 5_000)).toEqual({ leadSec: 0, tailSec: 0 });
  });

  it("keeps mid-run stops", () => {
    const tr = track().run(600).stand(120).run(600);
    expect(idleEdgesSec(tr.pts, T0, tr.t)).toEqual({ leadSec: 0, tailSec: 0 });
  });

  it("keeps a slow steep hike at the start", () => {
    const tr = track().run(600, 0.7).run(600);
    expect(idleEdgesSec(tr.pts, T0, tr.t).leadSec).toBe(0);
  });

  it("reads silence behind a gap marker as standing", () => {
    const tr = track().run(600).gap().stand(300);
    expect(idleEdgesSec(tr.pts, T0, tr.t).tailSec).toBe(300);
  });

  it("trims nothing on a trace that never moved, or without a run window", () => {
    const still = track().stand(300).stand(300);
    expect(idleEdgesSec(still.pts, T0, still.t)).toEqual({ leadSec: 0, tailSec: 0 });
    const tr = track().stand(200).run(600);
    expect(idleEdgesSec(tr.pts, null, tr.t)).toEqual({ leadSec: 0, tailSec: 0 });
  });
});

describe("trimmedMovingSec", () => {
  it("subtracts the idle ends from the moving clock", () => {
    const tr = track().stand(200).run(3600).stand(300);
    const stoppedAt = tr.t;
    expect(trimmedMovingSec(4100, tr.pts, T0, stoppedAt)).toEqual({ durationSec: 3600, trimmedSec: 500 });
  });

  it("credits manual pauses against the trim so no second is removed twice", () => {
    // Paused for the 200s at the start: the clock never counted them.
    const tr = track().stand(200).run(3600);
    expect(trimmedMovingSec(3600, tr.pts, T0, tr.t)).toEqual({ durationSec: 3600, trimmedSec: 0 });
  });
});
