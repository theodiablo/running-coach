// The share card's route line: simplified, projected, masked around start and
// finish, and fitted to the card's route box. Pure. docs/share-card.md ("Route").
import { simplify } from "../utils/geo";
import type { TrackPointOrGap } from "../utils/geo";

export type XY = [number, number];
export type Box = { x: number; y: number; w: number; h: number };

export const MASK_M = 300;
// Below this much drawn line the route style isn't offered. Not a point count:
// a straight street simplifies to two points.
export const MIN_KEPT_M = 200;
// Points out of simplification: bbox diagonal / this, in metres.
const SIMPLIFY_DIVISOR = 500;

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export type RouteShape = {
  // Card-pixel polylines, each drawn as its own path (never bridged).
  paths: XY[][];
  // Start and finish in card pixels; the dots when unmasked, the clip centres when masked.
  start: XY;
  finish: XY;
  masked: boolean;
  // The exact 300 m radius in card pixels (the canvas clip); null when unmasked.
  maskRadiusPx: number | null;
  keptM: number;
  keptPoints: number;
};

type Projected = { segs: XY[][]; start: XY; finish: XY };

type Origin = { lat0: number; lng0: number };

const realPoints = (points: TrackPointOrGap[]) =>
  points.filter((p): p is NonNullable<TrackPointOrGap> => !!p && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])));

// Across ±180° each longitude is shifted by 360° to stay next to the one before, or the
// projection, the simplifier and the mask read one step as a world apart.
export function unwrapLng(points: TrackPointOrGap[]): TrackPointOrGap[] {
  let prev: number | null = null;
  return points.map(p => {
    if (!p || !Number.isFinite(Number(p[1]))) return p;
    let lng = Number(p[1]);
    if (prev !== null) lng -= 360 * Math.round((lng - prev) / 360);
    prev = lng;
    return lng === Number(p[1]) ? p : [p[0], lng, ...p.slice(2)];
  });
}

function originOf(points: TrackPointOrGap[]): Origin | null {
  const real = realPoints(points);
  if (real.length < 2) return null;
  return { lat0: real.reduce((s, p) => s + Number(p[0]), 0) / real.length, lng0: real.reduce((s, p) => s + Number(p[1]), 0) / real.length };
}

// Every projection of one trace shares one origin, or the line and its start drift apart.
function project(points: TrackPointOrGap[], { lat0, lng0 }: Origin): Projected | null {
  const real = realPoints(points);
  if (real.length < 2) return null;
  const k = Math.cos(rad(lat0));
  // Screen axes: x east, y south (north up on the card).
  const toXY = (p: NonNullable<TrackPointOrGap>): XY => [rad(Number(p[1]) - lng0) * k * R, -rad(Number(p[0]) - lat0) * R];
  const segs: XY[][] = [];
  let cur: XY[] = [];
  for (const p of points) {
    if (!p) { if (cur.length) { segs.push(cur); cur = []; } continue; }
    if (!Number.isFinite(Number(p[0])) || !Number.isFinite(Number(p[1]))) continue;
    cur.push(toXY(p));
  }
  if (cur.length) segs.push(cur);
  return { segs, start: toXY(real[0]), finish: toXY(real[real.length - 1]) };
}

function bboxOf(segs: XY[][]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segs) for (const [x, y] of s) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// The parameter interval of leg a→b inside circle (c, r), or null.
function insideInterval(a: XY, b: XY, c: XY, r: number): [number, number] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const fx = a[0] - c[0], fy = a[1] - c[1];
  const A = dx * dx + dy * dy;
  const C = fx * fx + fy * fy - r * r;
  if (A === 0) return C <= 0 ? [0, 1] : null;
  const B = 2 * (fx * dx + fy * dy);
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = Math.max(0, (-B - sq) / (2 * A)), t2 = Math.min(1, (-B + sq) / (2 * A));
  return t1 < t2 ? [t1, t2] : null;
}

// The visible sub-intervals of [0, 1] once every inside interval is removed.
function visibleParts(hidden: [number, number][]): [number, number][] {
  const sorted = hidden.slice().sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  let at = 0;
  for (const [s, e] of sorted) {
    if (s > at) out.push([at, s]);
    if (e > at) at = e;
  }
  if (at < 1) out.push([at, 1]);
  return out.filter(([s, e]) => e - s > 1e-9);
}

const lerp = (a: XY, b: XY, t: number): XY => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// Clip polylines against circles, legs not points: a leg crossing a circle with
// both ends outside is split and its middle dropped.
export function clipOutsideCircles(segs: XY[][], centres: XY[], r: number): XY[][] {
  const out: XY[][] = [];
  for (const seg of segs) {
    let piece: XY[] = [];
    const flush = () => { if (piece.length >= 2) out.push(piece); piece = []; };
    if (seg.length === 1) {
      if (centres.every(c => Math.hypot(seg[0][0] - c[0], seg[0][1] - c[1]) > r)) out.push([seg[0]]);
      continue;
    }
    for (let i = 0; i < seg.length - 1; i++) {
      const a = seg[i], b = seg[i + 1];
      const hidden = centres.map(c => insideInterval(a, b, c, r)).filter((v): v is [number, number] => !!v);
      const parts = visibleParts(hidden);
      if (!parts.length) { flush(); continue; }
      for (const [s, e] of parts) {
        if (s > 1e-9 || !piece.length) { flush(); piece.push(lerp(a, b, s)); }
        piece.push(lerp(a, b, e));
        if (e < 1 - 1e-9) flush();
      }
    }
    flush();
  }
  return out;
}

const lengthOf = (segs: XY[][]) => segs.reduce((sum, s) => {
  let m = 0;
  for (let i = 1; i < s.length; i++) m += Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]);
  return sum + m;
}, 0);

function fitScale(segs: XY[][], box: Box, padPx: number): number {
  const bb = bboxOf(segs);
  const w = Math.max(bb.w, 1), h = Math.max(bb.h, 1);
  return Math.min((box.w - 2 * padPx) / w, (box.h - 2 * padPx) / h);
}

export type ShapeOpts = { box: Box; mask: boolean; strokePx: number };

// Null when there is no usable line to draw.
export function routeShape(points: TrackPointOrGap[] | null | undefined, opts: ShapeOpts): RouteShape | null {
  if (!points?.length) return null;
  points = unwrapLng(points);
  const origin = originOf(points);
  const raw = origin && project(points, origin);
  if (!origin || !raw) return null;
  const diag = Math.hypot(bboxOf(raw.segs).w, bboxOf(raw.segs).h);
  const simplified = project(simplify(points, Math.max(1, diag / SIMPLIFY_DIVISOR)), origin);
  if (!simplified) return null;
  const { start, finish } = raw;
  const pad = opts.strokePx / 2 + 2;
  let segs = simplified.segs.filter(s => s.length >= 2);
  if (opts.mask) {
    // The stroke paints half its width past the centre line: widen the circles by
    // that much at the final scale. Enlarging only shrinks the kept box (scale up),
    // so one refit is enough for the bound to hold.
    const first = clipOutsideCircles(segs, [start, finish], MASK_M);
    if (!first.length) return null;
    const r = MASK_M + (opts.strokePx / 2) / fitScale(first, opts.box, pad);
    segs = clipOutsideCircles(segs, [start, finish], r);
  }
  const keptPoints = segs.reduce((n, s) => n + s.length, 0);
  const keptM = lengthOf(segs);
  if (!segs.length || keptM < MIN_KEPT_M) return null;
  const bb = bboxOf(segs);
  const scale = fitScale(segs, opts.box, pad);
  const ox = opts.box.x + opts.box.w / 2 - (bb.minX + bb.w / 2) * scale;
  const oy = opts.box.y + opts.box.h / 2 - (bb.minY + bb.h / 2) * scale;
  const px = (p: XY): XY => [p[0] * scale + ox, p[1] * scale + oy];
  return {
    paths: segs.map(s => s.map(px)),
    start: px(start), finish: px(finish),
    masked: opts.mask,
    maskRadiusPx: opts.mask ? MASK_M * scale : null,
    keptM, keptPoints,
  };
}
