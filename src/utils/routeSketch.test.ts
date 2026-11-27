import { describe, expect, it } from "vitest";
import { routeSketchPath } from "./routeSketch";

const coords = (d: string) => [...d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])]);

describe("routeSketchPath", () => {
  it("fits a trace inside the box", () => {
    const d = routeSketchPath([[43.27, -2.011, 0, 0], [43.28, -2.0, 1, 0], [43.275, -1.99, 2, 0]], 320, 112, 10);
    for (const [x, y] of coords(d)) {
      expect(x).toBeGreaterThanOrEqual(10 - 0.1); expect(x).toBeLessThanOrEqual(310 + 0.1);
      expect(y).toBeGreaterThanOrEqual(10 - 0.1); expect(y).toBeLessThanOrEqual(102 + 0.1);
    }
  });
  it("draws north up", () => {
    const [[, ySouth], [, yNorth]] = coords(routeSketchPath([[43.0, 1, 0, 0], [43.01, 1, 1, 0]], 100, 100));
    expect(yNorth).toBeLessThan(ySouth);
  });
  it("lifts the pen over a gap", () => {
    const d = routeSketchPath([[43, 1, 0, 0], [43.01, 1, 1, 0], null, [43.01, 1.01, 2, 0], [43, 1.01, 3, 0]], 100, 100);
    expect(d.match(/M/g)).toHaveLength(2);
  });
  it("draws nothing without at least two places", () => {
    expect(routeSketchPath([], 100, 100)).toBe("");
    expect(routeSketchPath([[43, 1, 0, 0]], 100, 100)).toBe("");
    expect(routeSketchPath([[43, 1, 0, 0], [43, 1, 5, 0]], 100, 100)).toBe("");
    expect(routeSketchPath(undefined, 100, 100)).toBe("");
  });
});
