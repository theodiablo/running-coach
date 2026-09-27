import { describe, it, expect } from "vitest";
import { haversineM, distanceKm, elevGainM, flattenTrack, simplify, segments, accuracyOK, type TrackPointOrGap } from "./geo";

const pt = (lat: number, lng: number): [number, number] => [lat, lng];
const pos = (alt: number | null): { lat: number; lng: number; alt: number | null } => ({ lat: 0, lng: 0, alt });
const ok = accuracyOK as (pos: { coords?: { accuracy?: number | null } } | null | undefined) => boolean;

describe("haversineM", () => {
  it("is zero for identical points", () => {
    expect(haversineM(pt(48.0, 2.0), pt(48.0, 2.0))).toBe(0);
  });
  it("measures ~111 km per degree of latitude", () => {
    const m = haversineM(pt(0, 0), pt(1, 0));
    expect(m).toBeGreaterThan(110000);
    expect(m).toBeLessThan(112000);
  });
  it("accepts {lat,lng} objects too", () => {
    const arr = haversineM(pt(0, 0), pt(0, 1));
    const obj = haversineM({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    expect(obj).toBeCloseTo(arr, 5);
  });
});

describe("distanceKm", () => {
  it("sums segment lengths", () => {
    const km = distanceKm([pt(0, 0), pt(0, 1), pt(0, 2)]);
    expect(km).toBeGreaterThan(220);
    expect(km).toBeLessThan(224);
  });
  it("skips sub-threshold jitter", () => {
    // ~0.1 m apart — below the 3 m default gate.
    const pts = [pt(48.0, 2.0), pt(48.000001, 2.0)];
    expect(distanceKm(pts)).toBe(0);
  });
  it("bridges gap markers with the straight-line (minimum) distance", () => {
    const withGap = distanceKm([pt(0, 0), pt(0, 1), null, pt(0, 5), pt(0, 6)]);
    const noGap = distanceKm([pt(0, 0), pt(0, 1), pt(0, 5), pt(0, 6)]);
    expect(withGap).toBeCloseTo(noGap, 5);
  });
});

describe("elevGainM", () => {
  it("counts only ascents above the noise band", () => {
    expect(elevGainM([pos(100), pos(110), pos(105), pos(120)])).toBe(25);
  });
  it("ignores points without altitude", () => {
    expect(elevGainM([pos(null), pos(100), pos(130)])).toBe(30);
  });
  it("ignores descents", () => {
    expect(elevGainM([pos(200), pos(100)])).toBe(0);
  });
  it("filters GPS vertical noise on flat ground", () => {
    // Altitude jittering ±a few metres around 55m on a flat run must read ~0,
    // not accumulate every +1/+2 wiggle.
    const flat = [55, 56, 55, 54, 56, 57, 55, 53, 56, 55].map(pos);
    expect(elevGainM(flat)).toBe(0);
  });
});

// A real 14.5km / ~800m D+ race recorded on a phone, as "seconds altitude" pairs
// ("G" = gap marker), coordinates dropped. Its GPS altitude glitches down by
// 150-400m for a few fixes at a time (367 -> 169 -> 319, 483 -> 91 -> 396).
const GLITCHY_RACE = (
  "0 70|G|220.203 70|223.202 70|225.461 70|230.523 70|253.2 70|270.222 70|" +
  "277.395 70|294.099 70|297.859 70|314.203 74|321.762 77|348.158 79|" +
  "375.222 86|405.321 94|411.203 94|418.041 94|467.203 92|522.783 89|" +
  "553.575 89|G|628.203 119|645.654 119|690.901 119|701.24 98|718.637 94|" +
  "734.835 94|748.233 94|789.202 94|827.023 91|870.882 111|897.015 110|" +
  "909.874 114|939.2 119|963.2 119|991.762 82|1026.48 82|1044.83 82|1154.2 135|" +
  "1285.19 199|1308.17 202|1370.19 221|1386.19 226|1410.04 230|1434.19 235|" +
  "1480.19 251|1504.59 254|1522.48 257|1546.64 258|1585.19 257|1600.58 252|" +
  "1607.27 241|1648.79 214|1662.19 216|1682.91 221|1698.19 228|1717.46 231|" +
  "1755.19 244|1841.22 264|1875.29 271|1913.99 278|1938.19 282|2065.1 317|" +
  "2102.09 326|2145.21 332|2201.02 345|2279.2 367|2319.44 169|2353.13 169|" +
  "2371.82 169|2398.43 319|2410.64 310|2431.27 302|2437.62 298|2445.48 292|" +
  "2489.34 262|2518.73 262|2537.75 261|2563.19 261|2594.19 270|2605.16 271|" +
  "2650.55 281|2688.19 284|2694.19 283|2712.54 286|2740.19 288|2770.97 292|" +
  "2784.08 291|2803.78 294|2856.2 294|2876.14 305|2908.04 310|2985.71 296|" +
  "3001.82 299|3015.19 292|3041.45 291|3049.58 290|3073.74 290|3101.81 286|" +
  "3114.74 281|3144.19 272|3178.05 272|3190.7 264|3213.99 250|3227.19 242|" +
  "3240.49 236|3251.52 233|3271.18 224|3293.12 226|3324.06 221|3355.34 221|" +
  "3371.19 220|3396.32 218|3413.22 216|3436.47 222|3451.98 225|3474.19 223|" +
  "3485.16 223|3516.04 230|3531.19 237|3555.37 240|3595.19 254|3606.19 255|" +
  "3630.19 255|3652.36 262|3681.14 268|3707.47 279|3767.08 293|3795.19 299|" +
  "3842.46 312|3873.39 313|3965.19 331|3997.19 335|4040.59 341|4049.17 331|" +
  "4092.94 349|4095.88 351|4100.24 351|4116.17 358|4121.17 358|4161.17 369|" +
  "4236.17 379|4272.21 377|4347.18 396|4400.17 402|4437.17 408|4505.08 419|" +
  "4535.68 417|4566.17 420|4631.6 437|4655.04 441|4683.17 448|4753.1 464|" +
  "4772.5 471|4794.56 476|4861.14 491|4865.17 491|4893.82 491|4926.17 486|" +
  "4942.01 489|4946.49 488|4963.91 486|4988.89 486|5004.1 488|5016.17 488|" +
  "5026.5 483|5047.64 181|5064.62 181|5092.95 181|5136.17 109|5163.41 91|" +
  "5174.18 91|5194.17 91|5236.18 396|5257.52 392|5281.53 389|5299.17 388|" +
  "5322.61 377|5334.58 370|5363.01 355|5371.41 350|5380.87 347|5406.59 333|" +
  "5421.79 324|5440.55 169|5451.15 169|5458.97 169|5468.73 169|5481.81 169|" +
  "5501.35 169|5510.77 169|5523.72 267|5539.17 265|5576.17 266|5579.59 265|" +
  "5586.16 262|5598.17 257|5601.59 255|5604.4 254|5610.17 252|5643.83 242|" +
  "5663.17 237|5692.2 238|5711.31 235|5726.95 236|5733.9 237|5750.65 237|" +
  "5776.33 237|5792.54 233|5807.17 228|5839.85 221|5853.19 218|5868.51 217|" +
  "5975.57 244|6003.91 252|6017.17 254|6056.17 262|6074.17 265|6099.63 266|" +
  "6124.11 260|6158.97 261|6168.75 254|6184.95 246|6202.05 229|6231.59 211|" +
  "6243.77 204|6319.36 170|6360.17 76|6369.84 76|6376.92 96|6394.56 96|" +
  "6410.17 124|6427.17 124|6442.7 124|6473.4 98|6493.5 98|6504.08 98|" +
  "6514.07 98|6531.17 98|6547.91 97|6579.17 99|6585.17 99|6640.17 99|" +
  "6650.12 99|6699.17 96|6717.12 97|6766.92 98|G|6843.17 98|6854.91 85|" +
  "6904.54 92|6985.03 94|6993.18 94|7021.04 88|7030.93 88|7043.46 88|" +
  "7063.15 78|7068.46 78|7084.39 72|7094.68 71|7111.85 71|7123.9 70|7156.03 70|" +
  "7191.15 70|7205.52 70|7210.91 70|7224.15 70|7253.15 69|7275.15 69|" +
  "7305.16 69|7375.15 69|G|7635.15 69"
).split("|").map((s): TrackPointOrGap => {
  if (s === "G") return null;
  const [sec, alt] = s.split(" ").map(Number);
  return [0, 0, sec * 1000, alt];
});

describe("elevGainM altitude glitches", () => {
  const at = (sec: number, alt: number): TrackPointOrGap => [0, 0, sec * 1000, alt];
  it("drops a short spike instead of counting its recovery as climb", () => {
    expect(elevGainM([at(0, 300), at(2, 150), at(4, 150), at(6, 300), at(8, 310)])).toBe(10);
  });
  it("keeps a real sustained climb", () => {
    const climb = Array.from({ length: 101 }, (_, i) => at(i * 2, 100 + i * 0.5)); // 0.25 m/s for 200s
    expect(elevGainM(climb)).toBeCloseTo(50, 0);
  });
  it("recovers when the first fix is the bad one", () => {
    // Truth climbs 100 -> 159m; the gate re-anchors once its allowance covers the 400m anchor's error.
    const pts = [at(0, 400), ...Array.from({ length: 60 }, (_, i) => at(10 + i * 10, 100 + i))];
    const gain = elevGainM(pts);
    expect(gain).toBeGreaterThan(25);
    expect(gain).toBeLessThanOrEqual(59);
  });
  it("reads a glitchy real race close to its true ~800m", () => {
    const gain = elevGainM(GLITCHY_RACE);
    expect(gain).toBeGreaterThan(700);
    expect(gain).toBeLessThan(900);
  });
  it("flattenTrack nulls the glitched altitudes it rejects", () => {
    const flat = flattenTrack([at(0, 300), at(2, 150), at(4, 300)]);
    expect(flat.map(f => f.alt)).toEqual([300, null, 300]);
  });
});

describe("simplify", () => {
  it("collapses collinear points to the endpoints", () => {
    const line = [pt(0, 0), pt(0, 1), pt(0, 2), pt(0, 3), pt(0, 4)];
    expect(simplify(line).length).toBe(2);
  });
  it("keeps a point that deviates beyond epsilon", () => {
    const pts = [pt(0, 0), pt(0.001, 1), pt(0, 2)];
    expect(simplify(pts, 5).length).toBe(3);
  });
  it("preserves gap markers between segments", () => {
    const out = simplify([pt(0, 0), pt(0, 1), pt(0, 2), null, pt(0, 5), pt(0, 6), pt(0, 7)]);
    expect(out).toContain(null);
  });
});

describe("segments", () => {
  it("splits on gap markers into [lat,lng] pairs", () => {
    const segs = segments([pt(1, 2), pt(3, 4), null, pt(5, 6)]);
    expect(segs).toEqual([[[1, 2], [3, 4]], [[5, 6]]]);
  });
});

describe("accuracyOK", () => {
  it("rejects low-accuracy fixes", () => {
    expect(ok({ coords: { accuracy: 80 } })).toBe(false);
  });
  it("accepts good fixes and missing accuracy", () => {
    expect(ok({ coords: { accuracy: 10 } })).toBe(true);
    expect(ok({ coords: {} })).toBe(true);
  });
});
