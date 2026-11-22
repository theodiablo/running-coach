// Draws a share card onto a 2D canvas in a fixed 360×640 design space; the
// caller scales (×3 for the 1080×1920 export). No roundRect/letterSpacing: the
// iOS 15.4 floor has neither. docs/share-card.md ("Rendering").
import type { Line, NumberModel, RouteModel, Stat, WeekModel } from "./cardModel";
import type { RouteShape } from "./routeShape";

export const CARD_W = 360;
export const CARD_H = 640;
export const ROUTE_BOX = { x: 26, y: 64, w: 308, h: 300 };
export const ROUTE_STROKE = 14;

export type TFn = (key: string, vars?: Record<string, string | number>) => string;

const INK = "#0b1220";
const LIGHT = "#f8fafc";
const MUTED = "#94a3b8";
const SOFT = "#cbd5e1";
const LINE = "#1e293b";
const ACCENT = "#f97316";
const ACCENT_SOFT = "#fdba74";
const PAD = 26;

const DISPLAY = "Archivo, Inter, sans-serif";
const BODY = "Inter, Archivo, sans-serif";
const font = (weight: number, size: number, family = BODY) => `${weight} ${size}px ${family}`;

export type CardView =
  | { style: "route"; model: RouteModel; shape: RouteShape | null; showRoute: boolean; date: string; footer: Line; t: TFn }
  | { style: "number"; model: NumberModel; date: string; t: TFn }
  | { style: "week"; model: WeekModel; dayLabels: string[]; runFigure: string; runLine: string; t: TFn };

type Ctx = CanvasRenderingContext2D;

export function roundRectPath(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const tr = (t: TFn, l: Line) => t(l.key, l.vars);

// Shrinks to `min` before ellipsing, so a long locale still fits its column.
export function fitText(ctx: Ctx, text: string, maxW: number, weight: number, size: number, min: number, family = BODY): string {
  for (let s = size; s >= min; s--) {
    ctx.font = font(weight, s, family);
    if (ctx.measureText(text).width <= maxW) return text;
  }
  return ellipsize(ctx, text, maxW);
}

function ellipsize(ctx: Ctx, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s.trimEnd() + "…";
}

// Word-wraps to at most `maxLines`; whatever doesn't fit ellipses the last line.
export function wrapText(ctx: Ctx, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (ctx.measureText(next).width <= maxW) { cur = next; continue; }
    if (cur) lines.push(cur);
    cur = w;
    if (lines.length === maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const used = lines.slice(0, maxLines);
  const rest = words.join(" ") !== used.join(" ");
  for (let i = 0; i < used.length - 1; i++) used[i] = ellipsize(ctx, used[i], maxW);
  if (used.length) {
    const last = used.length - 1;
    used[last] = rest ? ellipsize(ctx, used[last] + "…", maxW).replace(/……$/, "…") : ellipsize(ctx, used[last], maxW);
  }
  return used;
}

function text(ctx: Ctx, s: string, x: number, y: number, f: string, color: string, align: CanvasTextAlign = "left") {
  ctx.font = f;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(s, x, y);
}

function brandMark(ctx: Ctx, x: number, y: number, w: number, color: string) {
  const k = w / 220;
  const pts = [[10, 80], [60, 80], [78, 44], [96, 96], [114, 60], [132, 80], [160, 80], [200, 28]];
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 16 * k;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  pts.forEach(([px, py], i) => (i ? ctx.lineTo(x + px * k, y + py * k) : ctx.moveTo(x + px * k, y + py * k)));
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x + 200 * k, y + 28 * k, 12 * k, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function checkMark(ctx: Ctx, cx: number, cy: number, size: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.45, cy);
  ctx.lineTo(cx - size * 0.1, cy + size * 0.35);
  ctx.lineTo(cx + size * 0.5, cy - size * 0.35);
  ctx.stroke();
  ctx.restore();
}

// A value with a smaller unit after it, shrunk as one unit to fit `maxW`.
function valueWithUnit(ctx: Ctx, stat: Stat, x: number, y: number, size: number, maxW: number, color: string, unitColor: string) {
  const unit = stat.unit ? " " + stat.unit : "";
  let s = size;
  for (; s > 12; s--) {
    ctx.font = font(800, s, DISPLAY);
    const w1 = ctx.measureText(stat.value).width;
    ctx.font = font(600, Math.round(s * 0.55));
    if (w1 + ctx.measureText(unit).width <= maxW) break;
  }
  text(ctx, stat.value, x, y, font(800, s, DISPLAY), color);
  ctx.font = font(800, s, DISPLAY);
  const w = ctx.measureText(stat.value).width;
  if (unit) text(ctx, unit, x + w, y, font(600, Math.round(s * 0.55)), unitColor);
}

function statsRow(ctx: Ctx, t: TFn, stats: Stat[], y: number, o: { size: number; label: string; value: string; unit: string; labelWeight: number }) {
  const colW = (CARD_W - 2 * PAD - 8 * (stats.length - 1)) / Math.max(stats.length, 1);
  stats.forEach((st, i) => {
    const x = PAD + i * (colW + 8);
    const label = fitText(ctx, tr(t, st.label), colW, o.labelWeight, 11, 9);
    text(ctx, label, x, y + 16, ctx.font, o.label);
    valueWithUnit(ctx, st, x, y + 16 + o.size + 4, o.size, colW, o.value, o.unit);
  });
}

// Box, then one exclusion clip per circle: a single evenodd path would paint
// where the circles overlap, and nothing at all when start and finish coincide.
export function clipOutsideMask(ctx: Ctx, box: { x: number; y: number; w: number; h: number }, centres: [number, number][], r: number) {
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  for (const [cx, cy] of centres) {
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.moveTo(cx + r, cy);
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip("evenodd");
  }
}

export function drawRouteLine(ctx: Ctx, shape: RouteShape) {
  ctx.save();
  if (shape.masked && shape.maskRadiusPx != null) clipOutsideMask(ctx, ROUTE_BOX, [shape.start, shape.finish], shape.maskRadiusPx);
  else { ctx.beginPath(); ctx.rect(ROUTE_BOX.x, ROUTE_BOX.y, ROUTE_BOX.w, ROUTE_BOX.h); ctx.clip(); }
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [width, color] of [[ROUTE_STROKE, LINE], [5, ACCENT]] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    for (const path of shape.paths) {
      ctx.beginPath();
      path.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
  }
  if (!shape.masked) {
    ctx.beginPath();
    ctx.arc(shape.start[0], shape.start[1], 6, 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = LIGHT;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(shape.finish[0], shape.finish[1], 8, 0, Math.PI * 2);
    ctx.fillStyle = ACCENT;
    ctx.fill();
  }
  ctx.restore();
}

function drawRouteCard(ctx: Ctx, v: Extract<CardView, { style: "route" }>) {
  const { t, model } = v;
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  brandMark(ctx, PAD, 30, 29, ACCENT);
  text(ctx, "Running Coach", PAD + 37, 43, font(700, 13), LIGHT);
  text(ctx, v.date, CARD_W - PAD, 43, font(400, 12), MUTED, "right");

  if (v.showRoute && v.shape) drawRouteLine(ctx, v.shape);
  else {
    const big = model.stats[0];
    ctx.font = font(900, 84, DISPLAY);
    const figure = fitText(ctx, big.value, ROUTE_BOX.w, 900, 84, 40, DISPLAY);
    text(ctx, figure, CARD_W / 2, ROUTE_BOX.y + ROUTE_BOX.h / 2 + 20, ctx.font, LIGHT, "center");
    if (big.unit) text(ctx, big.unit, CARD_W / 2, ROUTE_BOX.y + ROUTE_BOX.h / 2 + 56, font(600, 20), SOFT, "center");
  }

  ctx.font = font(800, 22, DISPLAY);
  wrapText(ctx, tr(t, model.headline), CARD_W - 2 * PAD, 2).forEach((l, i) => text(ctx, l, PAD, 398 + i * 26, ctx.font, LIGHT));

  ctx.fillStyle = LINE;
  ctx.fillRect(PAD, 452, CARD_W - 2 * PAD, 1);
  statsRow(ctx, t, model.stats, 456, { size: 26, label: MUTED, value: LIGHT, unit: SOFT, labelWeight: 600 });

  if (model.pill) {
    const label = t("shareCard.route.pill", { dist: t(model.pill.dist), time: model.pill.time });
    const f = font(700, 13);
    ctx.font = f;
    const w = Math.min(ctx.measureText(label).width + 24, CARD_W - 2 * PAD);
    roundRectPath(ctx, PAD, 526, w, 30, 15);
    ctx.fillStyle = "rgba(249,115,22,0.14)";
    ctx.fill();
    text(ctx, ellipsize(ctx, label, w - 24), PAD + 12, 546, f, ACCENT_SOFT);
  }
  text(ctx, fitText(ctx, tr(t, v.footer), CARD_W - 2 * PAD, 400, 11, 9), PAD, 616, ctx.font, MUTED);
}

function drawNumberCard(ctx: Ctx, v: Extract<CardView, { style: "number" }>) {
  const { t, model } = v;
  ctx.fillStyle = ACCENT;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  if (model.tag) {
    const label = tr(t, model.tag);
    const f = font(700, 12);
    ctx.font = f;
    const w = Math.min(ctx.measureText(label).width + 22, 200);
    roundRectPath(ctx, PAD, 28, w, 26, 13);
    ctx.fillStyle = INK;
    ctx.fill();
    text(ctx, ellipsize(ctx, label, w - 22), PAD + 11, 45, f, ACCENT_SOFT);
  }
  text(ctx, v.date, CARD_W - PAD, 45, font(600, 12), INK, "right");

  const maxW = CARD_W - 2 * PAD;
  let y = 190;
  if (model.label) {
    text(ctx, fitText(ctx, tr(t, model.label), maxW, 900, 40, 24, DISPLAY), PAD, y, ctx.font, INK);
    y += 102;
  } else y += 60;
  const unit = model.unit ? " " + model.unit : "";
  let size = 112;
  for (; size > 48; size -= 2) {
    ctx.font = font(900, size, DISPLAY);
    const w = ctx.measureText(model.figure).width;
    ctx.font = font(900, Math.round(size * 0.36), DISPLAY);
    if (w + ctx.measureText(unit).width <= maxW) break;
  }
  text(ctx, model.figure, PAD, y, font(900, size, DISPLAY), INK);
  if (unit) {
    ctx.font = font(900, size, DISPLAY);
    const w = ctx.measureText(model.figure).width;
    text(ctx, unit, PAD + w, y, font(900, Math.round(size * 0.36), DISPLAY), INK);
  }
  if (model.context) {
    ctx.font = font(600, 17);
    wrapText(ctx, tr(t, model.context), 290, 2).forEach((l, i) => text(ctx, l, PAD, y + 40 + i * 23, ctx.font, INK));
  }

  ctx.fillStyle = INK;
  ctx.fillRect(PAD, 508, CARD_W - 2 * PAD, 2);
  statsRow(ctx, t, model.stats, 512, { size: 22, label: INK, value: INK, unit: INK, labelWeight: 700 });
  brandMark(ctx, PAD, 590, 33, INK);
  text(ctx, "Running Coach", PAD + 41, 604, font(700, 14), INK);
}

function drawWeekCard(ctx: Ctx, v: Extract<CardView, { style: "week" }>) {
  const { t, model } = v;
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  const maxW = CARD_W - 2 * PAD;
  let y = 46;
  const h = model.header;
  text(ctx, t(h.kind === "race" ? "shareCard.week.trainingFor" : "shareCard.week.training"), PAD, y, font(600, 12), MUTED);
  ctx.font = font(900, 30, DISPLAY);
  const title = h.kind === "race" ? (h.title || t("shareCard.week.myRace")) : t("shareCard.week.block", { block: h.block });
  const titleLines = wrapText(ctx, title, maxW, 2);
  titleLines.forEach((l, i) => text(ctx, l, PAD, y + 32 + i * 32, ctx.font, LIGHT));
  y += 32 + (titleLines.length - 1) * 32;
  if (h.kind === "race") {
    text(ctx, h.daysToGo === 0 ? t("shareCard.week.raceDay") : t("shareCard.week.daysToGo", { count: h.daysToGo }), PAD, y + 24, font(600, 15), ACCENT_SOFT);
    y += 24;
  }

  y += 30;
  const weekLabel = t("shareCard.week.weekOf", { n: model.weekN, m: model.weekM });
  text(ctx, weekLabel, PAD, y, font(600, 12), SOFT);
  if (model.phase) text(ctx, fitText(ctx, tr(t, model.phase), maxW / 2, 600, 12, 10), CARD_W - PAD, y, ctx.font, SOFT, "right");
  y += 10;
  const segs = Math.max(1, model.weekM);
  const gap = segs > 16 ? 2 : 4;
  const segW = (maxW - gap * (segs - 1)) / segs;
  for (let i = 0; i < segs; i++) {
    roundRectPath(ctx, PAD + i * (segW + gap), y, segW, 6, 3);
    ctx.fillStyle = i < model.weekN ? ACCENT : LINE;
    ctx.fill();
  }

  y += 24;
  const cardH = 118;
  roundRectPath(ctx, PAD, y, maxW, cardH, 18);
  ctx.fillStyle = "#111c33";
  ctx.fill();
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.stroke();
  text(ctx, t("shareCard.week.thisWeek"), PAD + 16, y + 26, font(600, 12), MUTED);
  const colW = (maxW - 32) / 7;
  model.days.forEach((d, i) => {
    const cx = PAD + 16 + colW * i + colW / 2;
    text(ctx, fitText(ctx, v.dayLabels[i] ?? "", colW, 600, 11, 8), cx, y + 50, ctx.font, MUTED, "center");
    const cy = y + 72;
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    if (d.isRunDay) {
      ctx.fillStyle = ACCENT;
      ctx.fill();
      if (d.state === "done") checkMark(ctx, cx, cy, 10, INK);
    } else if (d.state === "done") {
      ctx.fillStyle = "rgba(249,115,22,0.18)";
      ctx.fill();
      checkMark(ctx, cx, cy, 10, ACCENT_SOFT);
    } else {
      // Still open is a neutral ring, never a miss: the anti-streak stance.
      ctx.lineWidth = 2;
      ctx.strokeStyle = d.state === "open" ? "#475569" : LINE;
      ctx.stroke();
    }
  });
  const summary = t("shareCard.week.summary", { done: model.done, planned: model.planned, km: model.weekKm });
  text(ctx, fitText(ctx, summary, maxW - 32, 400, 13, 10), PAD + 16, y + cardH - 12, ctx.font, SOFT);

  y += cardH + 34;
  const dayName = model.runDay.today ? t("shareCard.week.today") : v.dayLabels[model.runDay.weekday] ?? "";
  text(ctx, fitText(ctx, t("shareCard.week.runRow", { day: dayName, type: tr(t, model.runType) }), maxW, 600, 12, 10), PAD, y, ctx.font, MUTED);
  text(ctx, fitText(ctx, v.runFigure, maxW, 900, 52, 28, DISPLAY), PAD, y + 54, ctx.font, LIGHT);
  text(ctx, fitText(ctx, v.runLine, maxW, 600, 15, 11), PAD, y + 82, ctx.font, SOFT);

  brandMark(ctx, PAD, 602, 29, ACCENT);
  text(ctx, fitText(ctx, t("shareCard.week.footer"), maxW - 40, 400, 12, 9), PAD + 37, 615, ctx.font, SOFT);
}

export function drawCard(ctx: Ctx, view: CardView, scale = 1) {
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  if (view.style === "route") drawRouteCard(ctx, view);
  else if (view.style === "number") drawNumberCard(ctx, view);
  else drawWeekCard(ctx, view);
  ctx.restore();
}
