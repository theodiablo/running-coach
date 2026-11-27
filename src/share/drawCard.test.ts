import { describe, it, expect, beforeAll } from "vitest";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import i18next from "i18next";
import en from "../i18n/locales/en";
import fr from "../i18n/locales/fr";
import es from "../i18n/locales/es";
import { drawCard, CARD_W, ROUTE_BOX, ROUTE_STROKE } from "./drawCard";
import type { CardView, TFn } from "./drawCard";
import { numberModel, routeModel, weekModel } from "./cardModel";
import type { CardInput } from "./cardModel";
import { routeShape } from "./routeShape";
import { addDays } from "../utils/format";
import type { Plan, Run, SettingsState } from "../types";

const FONT_FILES: [string, string][] = [
  ["Archivo", "@fontsource/archivo/files/archivo-latin-800-normal.woff2"],
  ["Archivo", "@fontsource/archivo/files/archivo-latin-900-normal.woff2"],
  ["Inter", "@fontsource/inter/files/inter-latin-400-normal.woff2"],
  ["Inter", "@fontsource/inter/files/inter-latin-600-normal.woff2"],
  ["Inter", "@fontsource/inter/files/inter-latin-700-normal.woff2"],
];

beforeAll(() => {
  for (const [family, file] of FONT_FILES) GlobalFonts.registerFromPath(require.resolve(file), family);
});

type Drawn = { s: string; x: number; w: number; align: string };

// A real canvas behind a proxy that records text and refuses what iOS 15.4 lacks.
function instrumented() {
  const canvas = createCanvas(360, 640);
  const target = canvas.getContext("2d");
  const texts: Drawn[] = [];
  const strokes: number[] = [];
  const ctx = new Proxy(target, {
    get(t, k) {
      if (k === "roundRect") throw new Error("ctx.roundRect is iOS 16+");
      if (k === "fillText") return (s: string, x: number, y: number) => { texts.push({ s, x, w: t.measureText(s).width, align: t.textAlign }); t.fillText(s, x, y); };
      if (k === "stroke") return () => { strokes.push(t.lineWidth); t.stroke(); };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
    set(t, k, v) {
      if (k === "letterSpacing") throw new Error("ctx.letterSpacing is iOS 18+");
      return Reflect.set(t, k, v);
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, texts, strokes };
}

function tFor(lng: string): TFn {
  const inst = i18next.createInstance();
  void inst.init({ lng, resources: { en: { translation: en }, fr: { translation: fr }, es: { translation: es } }, interpolation: { escapeValue: false } });
  return (key, vars) => inst.t(key, vars ?? {});
}

const settings = { raceDate: "", goalSec: "", distanceKm: "", raceElevation: 0, name: "" } as unknown as SettingsState;
const monday = "2026-11-16";
const LAT0 = 48.85, LNG0 = 2.35;
const loop = Array.from({ length: 400 }, (_, i) => {
  const a = (i / 399) * Math.PI * 2;
  return [LAT0 + Math.sin(a) * 0.02, LNG0 + Math.cos(a) * 0.03 - 0.03, i * 1000, null] as const;
});

function plan(): Plan {
  const weeks = Array.from({ length: 12 }, (_, i) => {
    const start = addDays(monday, (i - 5) * 7);
    const sessions = [0, 2, 4, 6].map(d => ({ id: `w${i}d${d}`, date: addDays(start, d), type: d === 6 ? "LONG" : "EASY", desc: "", km: 8, pace: 360, done: i < 5 || (i === 5 && d < 4) }));
    if (i === 11) sessions.push({ id: "race", date: addDays(start, 6), type: "RACE", desc: "", km: 21.1, pace: 300, done: false });
    return { weekNumber: i + 1, startDate: start, phase: "RECOVERY", sessions };
  });
  return { raceDate: weeks[11].sessions[4].date, weeks } as Plan;
}

// The widest content each style can carry: a measured best, a long race name, every stat.
function views(t: TFn): CardView[] {
  const run: Run = { id: "r", date: addDays(monday, 6), type: "LONG", km: 21.1, durationSec: 6512, hr: 151,
    bestEfforts: { "hm": 6480, "10k": 2991 } };
  const runs: Run[] = [{ id: "p", date: "2026-03-01", type: "EASY", km: 21.1, durationSec: 7000, bestEfforts: { "hm": 6999, "10k": 3029 } }];
  const input: CardInput = { run, runs, plan: plan(), settings, participations: [], today: run.date, hasRoute: true,
    raceLabel: "Behobia-San Sebastián Half Marathon and Fun Run 2026" };
  const shape = routeShape(loop, { box: ROUTE_BOX, mask: true, strokePx: ROUTE_STROKE });
  const week = weekModel(input)!;
  return [
    { style: "route", t, date: "29 Nov", showRoute: true, shape, model: routeModel(input, true), footer: { key: "shareCard.footerStores" } },
    { style: "route", t, date: "29 Nov", showRoute: false, shape, model: routeModel(input, true), footer: { key: "shareCard.footer" } },
    { style: "number", t, date: "29 Nov", model: numberModel(input, true) },
    { style: "week", t, model: week, dayLabels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], runFigure: "21.1 km", runLine: "1:48:32 · 5:08 /km" },
  ];
}

describe.each(["en", "fr", "es"])("drawCard in %s", (lng) => {
  it("keeps every line of text inside the card", () => {
    for (const view of views(tFor(lng))) {
      const { ctx, texts } = instrumented();
      drawCard(ctx, view);
      expect(texts.length).toBeGreaterThan(4);
      for (const d of texts) {
        const left = d.align === "right" ? d.x - d.w : d.align === "center" ? d.x - d.w / 2 : d.x;
        expect({ style: view.style, s: d.s, left: left >= 0, right: left + d.w <= CARD_W + 0.5 })
          .toEqual({ style: view.style, s: d.s, left: true, right: true });
      }
    }
  });

  it("never prints a raw i18n key", () => {
    for (const view of views(tFor(lng))) {
      const { ctx, texts } = instrumented();
      drawCard(ctx, view);
      expect(texts.filter(d => /shareCard\.|common\.|bestEfforts\./.test(d.s))).toEqual([]);
    }
  });
});

describe("render for eyes", () => {
  it.skipIf(!process.env.SHARE_RENDER)("writes pngs", async () => {
    const { writeFileSync } = await import("node:fs");
    for (const lng of ["en", "fr"]) views(tFor(lng)).forEach((v, i) => {
      const c = createCanvas(1080, 1920);
      drawCard(c.getContext("2d") as unknown as CanvasRenderingContext2D, v, 3);
      writeFileSync(`${process.env.SHARE_RENDER}/${lng}-${i}-${v.style}.png`, c.toBuffer("image/png"));
    });
  });
});

describe("drawCard details", () => {
  const t = tFor("en");

  it("wraps a word wider than the line without overflowing any line", () => {
    const view = views(t)[3] as Extract<CardView, { style: "week" }>;
    const wide: CardView = { ...view, model: { ...view.model, header: { kind: "race", title: "Supercalifragilisticexpialidociousmarathon and friends", daysToGo: 3 } } };
    const { ctx, texts } = instrumented();
    drawCard(ctx, wide);
    expect(texts.some(d => d.s.startsWith("Supercali") && d.s.endsWith("…"))).toBe(true);
    for (const d of texts) {
      const left = d.align === "right" ? d.x - d.w : d.align === "center" ? d.x - d.w / 2 : d.x;
      expect({ s: d.s, right: left + d.w }).toEqual({ s: d.s, right: Math.min(left + d.w, CARD_W - 26 + 0.5) });
    }
  });

  it("draws no tick on a run day whose planned session is still open", () => {
    const view = views(t)[3] as Extract<CardView, { style: "week" }>;
    const days = view.model.days.map((d, i) => i === 6 ? { ...d, state: "open" as const, isRunDay: true } : { ...d, state: "rest" as const, isRunDay: false });
    const { ctx, strokes } = instrumented();
    drawCard(ctx, { ...view, model: { ...view.model, days } });
    // Ticks are stroked at 2.4; rings at 2.
    expect(strokes.filter(w => w === 2.4)).toEqual([]);
  });
});

describe("drawCard switches", () => {
  const t = tFor("en");

  it("draws no route stroke with the route switched off", () => {
    const [on, off] = views(t);
    const a = instrumented(); drawCard(a.ctx, on);
    const b = instrumented(); drawCard(b.ctx, off);
    expect(a.strokes).toContain(ROUTE_STROKE);
    expect(b.strokes).not.toContain(ROUTE_STROKE);
  });

  it("prints no pace with the pace switch off", () => {
    const view = views(t)[2] as Extract<CardView, { style: "number" }>;
    const noPace: CardView = { ...view, model: { ...view.model, stats: view.model.stats.slice(0, 2) } };
    const { ctx, texts } = instrumented();
    drawCard(ctx, noPace);
    expect(texts.some(d => d.s.includes("/km"))).toBe(false);
  });
});
