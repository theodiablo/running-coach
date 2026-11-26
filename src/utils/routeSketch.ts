import type { TrackPointOrGap } from "./geo";

// An SVG path of a trace fitted into a w×h box, for a tile-free picture of a run (no map, no network).
// Equirectangular with the longitude squeezed by cos(latitude), so a loop keeps its shape; gaps lift the pen.
export function routeSketchPath(points: readonly TrackPointOrGap[] | null | undefined, w: number, h: number, pad = 8): string {
  const pts = (points || []).filter((p): p is NonNullable<TrackPointOrGap> =>
    !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 2) return "";
  const lat0 = pts.reduce((s, p) => s + Number(p[0]), 0) / pts.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xs = pts.map(p => Number(p[1]) * k), ys = pts.map(p => -Number(p[0]));
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX, spanY = maxY - minY;
  if (!spanX && !spanY) return "";
  const scale = Math.min(spanX ? (w - 2 * pad) / spanX : Infinity, spanY ? (h - 2 * pad) / spanY : Infinity);
  const ox = (w - spanX * scale) / 2, oy = (h - spanY * scale) / 2;
  const at = (x: number, y: number) => `${((x - minX) * scale + ox).toFixed(1)} ${((y - minY) * scale + oy).toFixed(1)}`;
  let d = "", pen = false, i = 0;
  for (const p of points || []) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) { pen = false; continue; }
    d += (pen ? "L" : "M") + at(xs[i], ys[i]);
    pen = true; i++;
  }
  return d;
}
