import { describe, it, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { drawRouteLine, ROUTE_BOX } from "./drawCard";
import type { RouteShape, XY } from "./routeShape";

// Renders the route layer for real and samples the hidden circles: the clip is
// the guarantee, so it is tested in pixels, not in recorded calls.
function render(start: XY, finish: XY, r: number) {
  const canvas = createCanvas(360, 640);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  // Lines straight through both centres, the worst case for a mask.
  const across = (c: XY): XY[] => [[ROUTE_BOX.x, c[1]], [ROUTE_BOX.x + ROUTE_BOX.w, c[1]]];
  const down = (c: XY): XY[] => [[c[0], ROUTE_BOX.y], [c[0], ROUTE_BOX.y + ROUTE_BOX.h]];
  const shape: RouteShape = {
    paths: [across(start), down(start), across(finish), down(finish)],
    start, finish, masked: true, maskRadiusPx: r, keptM: 1000, keptPoints: 8,
  };
  drawRouteLine(ctx, shape);
  const alphaAt = (x: number, y: number) => ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data[3];
  return { alphaAt };
}

function insideSamples(c: XY, r: number): XY[] {
  const out: XY[] = [];
  for (let dx = -r + 1; dx <= r - 1; dx += 2) for (let dy = -r + 1; dy <= r - 1; dy += 2) {
    if (Math.hypot(dx, dy) <= r - 1.5) out.push([c[0] + dx, c[1] + dy]);
  }
  return out;
}

describe.each<[string, XY, XY]>([
  ["separate circles", [110, 180], [250, 260]],
  ["overlapping circles", [160, 200], [190, 220]],
  ["coincident start and finish (a loop from the door)", [180, 214], [180, 214]],
])("route mask in pixels: %s", (_label, start, finish) => {
  const r = 30;
  const { alphaAt } = render(start, finish, r);

  it("paints nothing inside either circle", () => {
    const painted = [...insideSamples(start, r), ...insideSamples(finish, r)].filter(([x, y]) => alphaAt(x, y) > 0);
    expect(painted).toEqual([]);
  });

  it("still paints the line outside them", () => {
    expect(alphaAt(ROUTE_BOX.x + 6, start[1])).toBeGreaterThan(0);
  });
});
