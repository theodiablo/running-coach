import { describe, it, expect } from "vitest";
import { routeShape, clipOutsideCircles, MASK_M } from "./routeShape";
import type { RouteShape, XY } from "./routeShape";
import type { TrackPointOrGap } from "../utils/geo";

const LAT0 = 48.85, LNG0 = 2.35;
const M_PER_DEG = 111320;
// A trace from metre offsets (x east, y north), one fix per second.
const trace = (xy: ([number, number] | null)[]): TrackPointOrGap[] =>
  xy.map((p, i) => p ? [LAT0 + p[1] / M_PER_DEG, LNG0 + p[0] / (M_PER_DEG * Math.cos((LAT0 * Math.PI) / 180)), i * 1000, null] : null);

// Straight-line legs between waypoints, sampled every `step` metres.
function path(waypoints: [number, number][], step = 10): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const [a, b] = [waypoints[i], waypoints[i + 1]];
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  out.push(waypoints[waypoints.length - 1]);
  return out;
}

const BOX = { x: 26, y: 64, w: 308, h: 300 };
const STROKE = 14;

function segDist(p: XY, a: XY, b: XY) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// The painted stroke's nearest reach to a circle centre, in card pixels.
function nearestPaint(shape: RouteShape, c: XY) {
  let min = Infinity;
  for (const p of shape.paths) for (let i = 0; i < p.length - 1; i++) min = Math.min(min, segDist(c, p[i], p[i + 1]));
  return min - STROKE / 2;
}

const masked = (pts: TrackPointOrGap[]) => routeShape(pts, { box: BOX, mask: true, strokePx: STROKE })!;

describe("routeShape: the start/finish mask", () => {
  it("hides an out-and-back's pass back through the start, not just its ends", () => {
    const s = masked(trace(path([[0, 0], [3000, 0], [-3000, 0], [0, 600]])));
    expect(s).not.toBeNull();
    expect(nearestPaint(s, s.start)).toBeGreaterThanOrEqual(s.maskRadiusPx! - 1e-6);
    expect(nearestPaint(s, s.finish)).toBeGreaterThanOrEqual(s.maskRadiusPx! - 1e-6);
  });

  it("hides every lap's pass on a lap course", () => {
    const lap: [number, number][] = [[0, 0], [1500, 0], [1500, 1500], [0, 1500], [0, 0]];
    const s = masked(trace(path([...lap, ...lap.slice(1), ...lap.slice(1)])));
    expect(nearestPaint(s, s.start)).toBeGreaterThanOrEqual(s.maskRadiusPx! - 1e-6);
  });

  it("keeps the painted stroke out of the circle for a leg running just outside it", () => {
    // Sparse fixes: one long leg 310 m from the start, parallel to the circle's edge.
    const pts = trace([[0, 0], [0, -2000], [2000, -2000], [2000, 310], [-2000, 310], [-2000, -3000], [-4000, -3000]]);
    const s = masked(pts);
    expect(nearestPaint(s, s.start)).toBeGreaterThanOrEqual(s.maskRadiusPx! - 1e-6);
  });

  it("splits a long leg that crosses a circle with both ends outside it", () => {
    const pts = trace([[0, 0], [0, -2000], [-2500, -2000], [-2500, 100], [2500, 100], [2500, -3000]]);
    const s = masked(pts);
    expect(nearestPaint(s, s.start)).toBeGreaterThanOrEqual(s.maskRadiusPx! - 1e-6);
    // The crossing leg survives on both sides of the circle.
    const leftOf = s.paths.flat().some(([x, y]) => x < s.start[0] - s.maskRadiusPx! && Math.abs(y - s.start[1]) < s.maskRadiusPx!);
    const rightOf = s.paths.flat().some(([x, y]) => x > s.start[0] + s.maskRadiusPx! && Math.abs(y - s.start[1]) < s.maskRadiusPx!);
    expect([leftOf, rightOf]).toEqual([true, true]);
  });

  it("leaves a pass near a point that is neither start nor finish drawn", () => {
    const s = masked(trace(path([[-4000, 0], [4000, 0]])));
    const mid: XY = [(s.start[0] + s.finish[0]) / 2, (s.start[1] + s.finish[1]) / 2];
    expect(nearestPaint(s, mid)).toBeLessThan(0);
  });

  it("hides the start of a route that crosses the antimeridian", () => {
    // Out and back across 180°, starting 100 m west of it.
    const k = M_PER_DEG * Math.cos((-16.8 * Math.PI) / 180);
    const xs = path([[-100, 0], [3000, 0], [3000, 1000], [-3000, 1000], [-3000, 0], [-100, 0]]);
    const pts: TrackPointOrGap[] = xs.map(([x, y], i) => {
      const lng = 180 + x / k;
      return [-16.8 + y / M_PER_DEG, lng > 180 ? lng - 360 : lng, i * 1000, null];
    });
    const s = masked(pts);
    expect(s).not.toBeNull();
    expect(nearestPaint(s, s.start)).toBeGreaterThanOrEqual(s.maskRadiusPx! - 1e-6);
    expect(nearestPaint(s, s.finish)).toBeGreaterThanOrEqual(s.maskRadiusPx! - 1e-6);
    // The whole 6 km loop fills the card, not one leg across the world.
    expect(s.paths.flat().length).toBeGreaterThan(4);
  });

  it("offers nothing when a short loop sits inside the mask", () => {
    expect(masked(trace(path([[0, 0], [150, 0], [150, 150], [0, 150], [0, 0]])))).toBeNull();
  });

  it("draws the dots, not the mask, with the switch off", () => {
    const s = routeShape(trace(path([[0, 0], [2000, 0], [2000, 2000]])), { box: BOX, mask: false, strokePx: STROKE })!;
    expect(s.maskRadiusPx).toBeNull();
    expect(nearestPaint(s, s.start)).toBeLessThan(0);
  });
});

describe("routeShape: geometry", () => {
  it("never bridges a GPS gap", () => {
    const pts = trace([...path([[0, 0], [2000, 0]]), null, ...path([[2000, 2000], [4000, 2000]])]);
    const s = routeShape(pts, { box: BOX, mask: false, strokePx: STROKE })!;
    expect(s.paths.length).toBe(2);
  });

  it("keeps the shape's aspect ratio and stays inside the box", () => {
    const s = routeShape(trace(path([[0, 0], [4000, 0], [4000, 1000]])), { box: BOX, mask: false, strokePx: STROKE })!;
    const xs = s.paths.flat().map(p => p[0]), ys = s.paths.flat().map(p => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    expect(w / h).toBeCloseTo(4, 1);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(BOX.x);
    expect(Math.max(...xs)).toBeLessThanOrEqual(BOX.x + BOX.w);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(BOX.y);
    expect(Math.max(...ys)).toBeLessThanOrEqual(BOX.y + BOX.h);
  });

  it("draws north up", () => {
    const s = routeShape(trace(path([[0, 0], [0, 3000], [500, 3000]])), { box: BOX, mask: false, strokePx: STROKE })!;
    expect(s.finish[1]).toBeLessThan(s.start[1]);
  });

  it("simplifies a marathon-length trace to a bounded point count (in lat/lng)", () => {
    const zig: [number, number][] = Array.from({ length: 4201 }, (_, i) => [i * 10, Math.sin(i / 40) * 800 + (i % 2) * 2]);
    const s = routeShape(trace(zig), { box: BOX, mask: true, strokePx: STROKE })!;
    expect(s.keptPoints).toBeLessThan(1000);
    expect(s.keptPoints).toBeGreaterThan(20);
  });

  it("nothing usable from an empty or single-point trace", () => {
    expect(routeShape(null, { box: BOX, mask: true, strokePx: STROKE })).toBeNull();
    expect(routeShape(trace([[0, 0]]), { box: BOX, mask: false, strokePx: STROKE })).toBeNull();
  });
});

describe("clipOutsideCircles", () => {
  it("drops the inside of a leg through the circle and keeps both ends", () => {
    const out = clipOutsideCircles([[[-10, 0], [10, 0]]], [[0, 0]], 5);
    expect(out).toEqual([[[-10, 0], [-5, 0]], [[5, 0], [10, 0]]]);
  });

  it("handles coincident circles", () => {
    expect(clipOutsideCircles([[[-10, 0], [10, 0]]], [[0, 0], [0, 0]], MASK_M)).toEqual([]);
  });
});
