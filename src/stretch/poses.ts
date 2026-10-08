// Stretch figures as data: a side-view mannequin on a 200×200 board, ground at
// y=181, facing right. `far` limbs sit behind the body, `near` limbs in front;
// `target` marks the muscle being stretched, always on a near limb. A moving drill has two key frames with identical
// shapes, interpolated by `poseAt`. Detail: docs/stretching.md.

export type Pt = [number, number];
export type Chain = Pt[];

export type Pose = {
  head: Pt;
  torso: Chain;
  far: Chain[];
  near: Chain[];
  target?: Chain[];
  strap?: Chain[];
  wallX?: number;
};

export type PoseDef = Pose | { frames: [Pose, Pose]; periodMs: number };

const LIE_HEAD: Pt = [34, 166];
const LIE_TORSO: Chain = [[54, 170], [101, 172]];
const LIE_FAR_LEG: Chain = [[101, 172], [139, 173], [176, 174], [179, 161]];
const STAND_HEAD: Pt = [100, 36];
const STAND_TORSO: Chain = [[100, 57], [100, 104]];

export const POSES = {
  calfWall: {
    wallX: 165, head: [138, 51], torso: [[126, 68], [98, 106]],
    far: [[[126, 68], [147, 78], [161, 57]], [[98, 106], [128, 134], [124, 174], [137, 179]]],
    near: [[[98, 106], [78, 140], [58, 174], [70, 179]], [[126, 68], [149, 80], [163, 59]]],
    target: [[[77, 142], [61, 170]]],
  },
  calfBent: {
    wallX: 165, head: [131, 51], torso: [[122, 70], [100, 114]],
    far: [[[122, 70], [144, 79], [161, 60]], [[100, 114], [130, 140], [128, 175], [141, 179]]],
    near: [[[100, 114], [92, 150], [66, 174], [78, 179]], [[122, 70], [146, 81], [163, 62]]],
    target: [[[88, 154], [70, 170]]],
  },
  quad: {
    wallX: 148, head: STAND_HEAD, torso: STAND_TORSO,
    far: [[[100, 104], [101, 141], [100, 175], [112, 179]], [[100, 57], [123, 68], [144, 66]]],
    near: [[[100, 104], [93, 140], [73, 110], [62, 116]], [[100, 57], [86, 80], [75, 106]]],
    target: [[[99, 109], [94, 134]]],
  },
  hipFlexor: {
    head: [97, 72], torso: [[96, 93], [96, 140]],
    far: [[[96, 140], [132, 138], [132, 175], [145, 179]], [[96, 93], [108, 116], [124, 130]]],
    near: [[[96, 140], [80, 175], [44, 176], [32, 178]], [[96, 93], [113, 113], [130, 128]]],
    target: [[[94, 146], [86, 163]]],
  },
  hamStrap: {
    head: LIE_HEAD, torso: LIE_TORSO,
    far: [LIE_FAR_LEG, [[54, 170], [68, 148], [86, 129]]],
    near: [[[101, 172], [112, 136], [115, 98], [104, 93]], [[54, 170], [70, 146], [88, 127]]],
    target: [[[103, 165], [110, 141]]],
    strap: [[[88, 127], [113, 95]], [[86, 129], [111, 97]]],
  },
  kneeChest: {
    head: LIE_HEAD, torso: LIE_TORSO,
    far: [LIE_FAR_LEG, [[54, 170], [70, 152], [92, 144]]],
    near: [[[101, 172], [86, 140], [118, 150], [130, 147]], [[54, 170], [72, 150], [94, 142]]],
    target: [[[100, 166], [94, 153]]],
  },
  child: {
    head: [148, 162], torso: [[128, 150], [84, 162]],
    far: [[[84, 162], [116, 175], [82, 177], [70, 178]], [[128, 150], [150, 163], [175, 172]]],
    near: [[[84, 162], [118, 175], [84, 177], [72, 178]], [[128, 150], [152, 164], [177, 174]]],
    target: [[[112, 154], [90, 160]]],
  },
  legsWall: {
    wallX: 114, head: LIE_HEAD, torso: LIE_TORSO,
    far: [[[101, 172], [104, 135], [106, 98], [110, 86]], [[54, 170], [76, 176], [98, 177]]],
    near: [[[103, 172], [106, 135], [108, 98], [112, 86]], [[54, 170], [74, 174], [96, 176]]],
    target: [[[107, 131], [108, 104]]],
  },
  legSwing: {
    periodMs: 1500,
    frames: [
      { head: STAND_HEAD, torso: STAND_TORSO,
        far: [[[100, 104], [100, 141], [100, 175], [112, 179]], [[100, 57], [118, 70], [140, 72]]],
        near: [[[100, 104], [129, 128], [157, 150], [166, 141]], [[100, 57], [90, 82], [82, 105]]] },
      { head: STAND_HEAD, torso: STAND_TORSO,
        far: [[[100, 104], [100, 141], [100, 175], [112, 179]], [[100, 57], [118, 70], [140, 72]]],
        near: [[[100, 104], [76, 132], [52, 160], [46, 171]], [[100, 57], [108, 82], [120, 102]]] },
    ],
  },
  lunge: {
    periodMs: 2400,
    frames: [
      { head: STAND_HEAD, torso: STAND_TORSO,
        far: [[[100, 104], [98, 141], [98, 175], [110, 179]], [[100, 57], [96, 84], [96, 108]]],
        near: [[[100, 104], [102, 141], [100, 175], [112, 179]], [[100, 57], [104, 84], [106, 108]]] },
      { head: [99, 70], torso: [[98, 91], [96, 138]],
        far: [[[96, 138], [78, 170], [48, 165], [44, 178]], [[98, 91], [110, 114], [124, 124]]],
        near: [[[96, 138], [132, 138], [132, 175], [145, 179]], [[98, 91], [88, 115], [82, 137]]] },
    ],
  },
  highKnees: {
    periodMs: 700,
    frames: [
      { head: [104, 36], torso: [[103, 57], [100, 104]],
        far: [[[100, 104], [100, 141], [99, 172], [111, 179]], [[103, 57], [116, 80], [134, 70]]],
        near: [[[100, 104], [136, 100], [132, 136], [142, 142]], [[103, 57], [86, 79], [98, 100]]] },
      { head: [104, 36], torso: [[103, 57], [100, 104]],
        far: [[[100, 104], [136, 100], [132, 136], [142, 142]], [[103, 57], [86, 79], [98, 100]]],
        near: [[[100, 104], [100, 141], [99, 172], [111, 179]], [[103, 57], [116, 80], [134, 70]]] },
    ],
  },
  calfRaise: {
    periodMs: 1800,
    frames: [
      { wallX: 146, head: STAND_HEAD, torso: STAND_TORSO,
        far: [[[100, 104], [99, 141], [99, 175], [111, 179]], [[100, 57], [120, 68], [142, 64]]],
        near: [[[100, 104], [101, 141], [101, 175], [113, 179]], [[100, 57], [102, 84], [104, 108]]],
        target: [[[101, 145], [101, 170]]] },
      { wallX: 146, head: [100, 26], torso: [[100, 47], [100, 94]],
        far: [[[100, 94], [99, 131], [100, 165], [111, 179]], [[100, 47], [120, 58], [142, 58]]],
        near: [[[100, 94], [101, 131], [102, 165], [113, 179]], [[100, 47], [102, 74], [104, 98]]],
        target: [[[101, 135], [102, 160]]] },
    ],
  },
  catCow: {
    periodMs: 4000,
    frames: [
      { head: [151, 108], torso: [[132, 124], [109, 140], [86, 138]],
        far: [[[130, 124], [130, 150], [131, 176]], [[86, 138], [84, 176], [50, 177], [40, 178]]],
        near: [[[132, 124], [133, 150], [134, 176]], [[86, 138], [88, 176], [52, 177], [42, 178]]] },
      { head: [146, 143], torso: [[132, 124], [109, 112], [86, 138]],
        far: [[[130, 124], [130, 150], [131, 176]], [[86, 138], [84, 176], [50, 177], [40, 178]]],
        near: [[[132, 124], [133, 150], [134, 176]], [[86, 138], [88, 176], [52, 177], [42, 178]]] },
    ],
  },
} satisfies Record<string, PoseDef>;

export type PoseId = keyof typeof POSES;

/** A figure facing right shows its right side, so the near limbs are the right ones: a left-side stretch is drawn mirrored. */
export const mirrorFor = (side: "left" | "right" | null | undefined): boolean => side === "left";

export function isMoving(def: PoseDef): def is { frames: [Pose, Pose]; periodMs: number } {
  return "frames" in def;
}

function lerpChain(a: Chain, b: Chain, t: number): Chain {
  return a.map(([x, y], i) => [x + (b[i][0] - x) * t, y + (b[i][1] - y) * t]);
}

function lerpChains(a: Chain[] | undefined, b: Chain[] | undefined, t: number): Chain[] | undefined {
  return a && b ? a.map((c, i) => lerpChain(c, b[i], t)) : a;
}

/** The pose `t` of the way (0..1) from a drill's first key frame to its second. */
export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return {
    head: lerpChain([a.head], [b.head], t)[0],
    torso: lerpChain(a.torso, b.torso, t),
    far: lerpChains(a.far, b.far, t)!,
    near: lerpChains(a.near, b.near, t)!,
    target: lerpChains(a.target, b.target, t),
    strap: lerpChains(a.strap, b.strap, t),
    wallX: a.wallX,
  };
}

/** A drill's pose `ms` into its loop (eased there and back); a hold's only pose. */
export function poseAt(def: PoseDef, ms: number): Pose {
  if (!isMoving(def)) return def;
  const phase = (((ms % def.periodMs) + def.periodMs) % def.periodMs) / def.periodMs;
  return lerpPose(def.frames[0], def.frames[1], (1 - Math.cos(2 * Math.PI * phase)) / 2);
}

/** A square viewBox hugging every frame of a pose, for small thumbnails. */
export function cropViewBox(def: PoseDef): string {
  const xs: number[] = [], ys: number[] = [];
  const add = ([x, y]: Pt) => { xs.push(x); ys.push(y); };
  for (const f of isMoving(def) ? def.frames : [def]) {
    [f.torso, ...f.far, ...f.near].forEach(c => c.forEach(add));
    add([f.head[0] - 11, f.head[1] - 11]);
    add([f.head[0] + 11, f.head[1] + 11]);
    if (f.wallX !== undefined) { add([f.wallX, 181]); add([f.wallX + 9, 181]); }
  }
  const x0 = Math.min(...xs) - 9, x1 = Math.max(...xs) + 9, y0 = Math.min(...ys) - 9, y1 = 183;
  const side = Math.max(x1 - x0, y1 - y0);
  const r = (n: number) => Math.round(n * 10) / 10;
  return [r((x0 + x1) / 2 - side / 2), r(y1 - side), r(side), r(side)].join(" ");
}
