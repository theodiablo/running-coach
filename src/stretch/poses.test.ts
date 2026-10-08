import { describe, it, expect } from "vitest";
import { POSES, isMoving, mirrorFor } from "./poses";
import type { Chain, Pose, PoseDef, Pt } from "./poses";
import { MOVE_KIND, ROUTINES } from "./routines";

const segDist = ([px, py]: Pt, [ax, ay]: Pt, [bx, by]: Pt) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const onChains = (p: Pt, chains: Chain[]) =>
  Math.min(...chains.flatMap(c => c.slice(1).map((b, i) => segDist(p, c[i], b))));

const frames = (id: keyof typeof POSES): Pose[] => {
  const def: PoseDef = POSES[id];
  return isMoving(def) ? def.frames : [def];
};

describe("stretch figures", () => {
  // The unmirrored drawing shows the right side, so the stretched muscle must be on a near limb.
  it.each(Object.keys(POSES) as (keyof typeof POSES)[])("%s marks its target on a near limb", id => {
    for (const f of frames(id)) {
      for (const c of f.target ?? []) {
        for (const p of c) expect(onChains(p, f.near)).toBeLessThan(onChains(p, f.far) + 0.01);
      }
    }
  });

  it("draws a left-side stretch mirrored and a right-side one as is", () => {
    expect(mirrorFor("left")).toBe(true);
    expect(mirrorFor("right")).toBe(false);
    expect(mirrorFor(null)).toBe(false);
  });

  it("gives every two-sided hold a target to show which leg works", () => {
    const twoSided = new Set(Object.values(ROUTINES).flatMap(r => [...r.items, ...(r.tail ?? [])]).filter(i => i.sides === 2).map(i => i.move));
    for (const id of twoSided) {
      if (MOVE_KIND[id] === "hold") expect(frames(id)[0].target?.length).toBeGreaterThan(0);
    }
  });
});
