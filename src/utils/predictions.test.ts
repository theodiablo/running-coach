import { describe, it, expect } from "vitest";
import { riegel, riegelKm, flatEqKm, bestEffortAnchor, linReg, seAt, hrModelAnchor, hrModelUsable } from "./predictions";

describe("riegel", () => {
  it("returns the same time for the same distance", () => {
    expect(riegel(3600, 10, 10)).toBeCloseTo(3600, 5);
  });
});

describe("flatEqKm", () => {
  it("credits elevation gain as extra flat distance", () => {
    expect(flatEqKm({km: 10, elevation: 100})).toBeCloseTo(10.8, 6); // VERT_COST=8
  });
  it("returns raw km with no/zero elevation", () => {
    expect(flatEqKm({km: 10, elevation: 0})).toBe(10);
    expect(flatEqKm({km: 10})).toBe(10);
  });
});

describe("riegelKm", () => {
  it("inverts riegel: the distance covered in the projected time", () => {
    expect(riegelKm(1000, 5, riegel(1000, 5, 12))).toBeCloseTo(12, 6);
  });
});

describe("linReg", () => {
  it("recovers a perfect line with R²=1", () => {
    const fit = linReg([{x: 0, y: 1}, {x: 1, y: 3}, {x: 2, y: 5}])!;
    expect(fit.a).toBeCloseTo(1, 6);
    expect(fit.b).toBeCloseTo(2, 6);
    expect(fit.r2).toBeCloseTo(1, 6);
  });
  it("returns null with fewer than two points", () => {
    expect(linReg([{x: 1, y: 1}])).toBeNull();
  });
  it("returns null when x has no variance", () => {
    expect(linReg([{x: 5, y: 1}, {x: 5, y: 9}])).toBeNull();
  });
  it("reports zero residual spread for a perfect line", () => {
    expect(linReg([{x: 0, y: 1}, {x: 1, y: 3}, {x: 2, y: 5}])!.resSd).toBeCloseTo(0, 6);
  });
});

describe("seAt", () => {
  const fit = linReg([{x: 1, y: 2}, {x: 2, y: 3.5}, {x: 3, y: 5.5}, {x: 4, y: 7}])!;
  it("is smallest at the centroid and grows with distance from it", () => {
    const [atMean, near, far] = [seAt(fit, fit.mx)!, seAt(fit, 5)!, seAt(fit, 20)!];
    expect(atMean).toBeLessThan(near);
    expect(near).toBeLessThan(far);
  });
  it("is null when there aren't enough points to estimate residuals", () => {
    expect(seAt(linReg([{x: 0, y: 0}, {x: 1, y: 1}])!, 5)).toBeNull();
  });
});

describe("bestEffortAnchor", () => {
  it("picks the strongest Riegel-equivalent effort, not the shortest fast blip", () => {
    const fastBlip = {date: "2026-01-01", km: 1, durationSec: 200};               // excluded (<3 km)
    const okRun    = {date: "2026-01-02", km: 5, durationSec: 1500};              // 5:00/km
    const strong   = {date: "2026-01-03", km: 10, durationSec: 3000};            // 5:00/km but longer → better eq
    const best = bestEffortAnchor([fastBlip, okRun, strong])!;
    expect(best.raw).toBe(strong);
    expect(best.km).toBe(10);
    expect(best.durationSec).toBe(3000);
  });
  it("returns null when no run qualifies", () => {
    expect(bestEffortAnchor([{date: "2026-01-01", km: 2, durationSec: 600}])).toBeNull();
  });
});

describe("hrModelAnchor", () => {
  // Profile used throughout: max 190 / rest 60 → Z2 floor 138, threshold 174.
  const MAX = 190, REST = 60;
  // A run at `hr` holding `pace` (sec/km) over 10 flat km.
  const at = (hr: number, pace: number, i = 0) => ({date: `2026-01-${String(i + 1).padStart(2, "0")}`, km: 10, durationSec: pace * 10, hr});
  // Nine runs, 150→174 bpm, pace falling a clean 2 s/km per bpm.
  const clean = Array.from({length: 9}, (_, i) => at(150 + 3 * i, 500 - 6 * i, i));

  it("returns null without an effective max HR", () => {
    expect(hrModelAnchor([], 0, REST)).toBeNull();
  });

  it("fits pace against HR and reads it off at threshold effort", () => {
    const r = hrModelAnchor(clean, MAX, REST)!;
    expect(r.n).toBe(9);
    expect(r.durationSec).toBe(3600);
    expect(r.spread).toBe(24);
    expect(r.thrHR).toBe(174); // Karvonen: round((190 - 60) * 0.88 + 60)
    expect(r.atHR).toBe(174);  // data reaches threshold, so nothing is capped
    expect(r.capped).toBe(false);
    expect(r.slope).toBeCloseTo(-2, 6);
    expect(r.thrPace).toBeCloseTo(452, 6); // 500 − 2 × (174 − 150)
    expect(r.km).toBeCloseTo(3600 / 452, 6);
    expect(hrModelUsable(r)).toBe(true);
  });

  // The bug this guards: two recovery-zone walk/jogs 25+ bpm below everything
  // else steepened the fit to −8 s/km/bpm and turned a 26:38 5 km runner into an
  // 18:07 one. Z1 efforts aren't on the same pace/HR line, so they sit out.
  it("ignores recovery-zone efforts instead of letting them tilt the line", () => {
    const walks = [at(115, 712, 20), at(120, 701, 21)]; // ~11:50/km, well under Z2
    expect(hrModelAnchor([...clean, ...walks], MAX, REST)!.km)
      .toBeCloseTo(hrModelAnchor(clean, MAX, REST)!.km, 6);
  });

  it("caps an implausibly steep slope at 1% of mean pace per bpm", () => {
    // 700 → 200 s/km over 20 bpm is −25 s/km/bpm; mean pace 450 caps it at −4.5.
    const steep = Array.from({length: 9}, (_, i) => at(150 + 2.5 * i, 700 - 62.5 * i, i));
    expect(hrModelAnchor(steep, MAX, REST)!.slope).toBeCloseTo(-4.5, 6);
  });

  it("reads no more than 8 bpm past the hardest effort logged", () => {
    const easyOnly = Array.from({length: 9}, (_, i) => at(140 + 2 * i, 500 - 4 * i, i)); // tops out at 156
    const r = hrModelAnchor(easyOnly, MAX, REST)!;
    expect(r.atHR).toBe(164);
    expect(r.thrHR).toBe(174);
    expect(r.capped).toBe(true);
  });

  it("clamps the anchor to 1.25× the best logged effort's hourly distance", () => {
    const best = {km: 5, durationSec: 3600}; // 5 km in an hour — far slower than the fit
    const r = hrModelAnchor(clean, MAX, REST, best)!;
    expect(r.km).toBeCloseTo(6.25, 6);
    expect(r.clamped).toBe(true);
  });

  it("leaves the anchor alone when it's within reach of the best effort", () => {
    const r = hrModelAnchor(clean, MAX, REST, {km: 7.5, durationSec: 3600})!;
    expect(r.km).toBeCloseTo(3600 / 452, 6);
    expect(r.clamped).toBe(false);
  });
});

describe("hrModelUsable", () => {
  const MAX = 190, REST = 60;
  const at = (hr: number, pace: number, i = 0) => ({date: `2026-01-${String(i + 1).padStart(2, "0")}`, km: 10, durationSec: pace * 10, hr});

  it("rejects a null anchor", () => {
    expect(hrModelUsable(null)).toBe(false);
  });

  it("rejects too few runs", () => {
    const few = Array.from({length: 7}, (_, i) => at(150 + 3 * i, 500 - 6 * i, i));
    expect(hrModelUsable(hrModelAnchor(few, MAX, REST))).toBe(false);
  });

  it("rejects a narrow spread of efforts", () => {
    const narrow = Array.from({length: 9}, (_, i) => at(150 + i, 500 - 2 * i, i)); // 8 bpm
    expect(hrModelUsable(hrModelAnchor(narrow, MAX, REST))).toBe(false);
  });

  it("rejects a fit where pace doesn't improve with HR", () => {
    const flat = Array.from({length: 9}, (_, i) => at(150 + 3 * i, 500 + 6 * i, i));
    expect(hrModelUsable(hrModelAnchor(flat, MAX, REST))).toBe(false);
  });

  it("rejects a fit too scattered to extrapolate from", () => {
    // Same pace logged at wildly different HRs and vice-versa: a line can be
    // drawn, but its prediction at threshold is worth nothing.
    const scattered = [
      at(155, 347, 0), at(153, 330, 1), at(146, 377, 2), at(153, 372, 3), at(150, 410, 4),
      at(145, 420, 5), at(155, 434, 6), at(145, 411, 7), at(142, 499, 8), at(162, 393, 9),
    ];
    const r = hrModelAnchor(scattered, MAX, REST)!;
    expect(r.slope).toBeLessThan(0);
    expect(r.n).toBe(10);
    expect(hrModelUsable(r)).toBe(false);
  });
});
