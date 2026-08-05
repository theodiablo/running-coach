import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { cloneElement, isValidElement } from "react";
import type { ReactElement } from "react";

// Recharts' ResponsiveContainer measures its parent, which is 0×0 in jsdom, so
// nothing would render. Force a fixed size onto the inner chart so recharts
// computes real scales (it uses the explicit width/height, not layout APIs).
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      isValidElement(children) ? cloneElement(children, { width: 400, height: 200 } as Record<string, unknown>) : children,
  };
});

import { RunChart, Readout } from "../components/RunChart";
import { activeIndexFromChartState } from "../utils/chartCursor";
import { buildRunSeries } from "../utils/runSeries";
import { flattenTrack } from "../utils/geo";
import type { RunSeriesRow } from "../utils/runSeries";
import type { TrackPointOrGap } from "../utils/geo";

afterEach(cleanup);

const ELEV = "#10b981", PACE = "#38bdf8", HR = "#f87171";
const ALL = { elev: true, pace: true, hr: true };

// Three points spaced UNEVENLY in distance (0, 0.5, 1.2 km) but at even indices,
// so a numeric axis and a categorical axis place the middle point differently.
const series: RunSeriesRow[] = [
  { distKm: 0,   tSec: 0,   elevM: 100, paceSecPerKm: 300, hr: 130 },
  { distKm: 0.5, tSec: 150, elevM: 110, paceSecPerKm: 290, hr: 140 },
  { distKm: 1.2, tSec: 360, elevM: 95,  paceSecPerKm: 280, hr: 150 },
];

// Pull the DATA-POINT vertex x-coordinates out of a recharts curve path's `d`.
// A monotone (curveMonotoneX) line is `M x,y C ... x,y C ... x,y`: the vertices
// are the M point and the endpoint of each cubic C (every 3rd coordinate pair).
function xCoords(path: Element | null): number[] {
  const d = path?.getAttribute("d") || "";
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const px: number[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) px.push(nums[i]); // x of each coord pair
  return px.filter((_, i) => i % 3 === 0);                        // M + each C endpoint
}

describe("RunChart", () => {
  it("renders one area (elevation) and two lines (pace, HR) when all series are on", () => {
    const { container } = render(<RunChart series={series} show={ALL} hasElev hasHr />);
    // No throw ⇒ every series' yAxisId resolved to a matching YAxis (the trap:
    // recharts errors when a series references a missing yAxisId).
    expect(container.querySelectorAll(".recharts-area").length).toBe(1);
    expect(container.querySelectorAll(".recharts-line").length).toBe(2);
    expect(container.querySelector(".recharts-xAxis")).toBeTruthy();
  });

  it("places the middle point by its DISTANCE value, not its index (numeric x-axis)", () => {
    const { container } = render(<RunChart series={series} show={ALL} hasElev hasHr />);
    const pacePath = container.querySelector(`path.recharts-curve[stroke="${PACE}"]`);
    const xs = xCoords(pacePath);
    expect(xs.length).toBe(3);
    // Fraction of the way the middle vertex sits between the first and last.
    // Numeric axis ⇒ 0.5/1.2 ≈ 0.417; a categorical axis would put it at 0.5.
    const frac = (xs[1] - xs[0]) / (xs[2] - xs[0]);
    expect(frac).toBeCloseTo(0.5 / 1.2, 1);
    expect(frac).toBeLessThan(0.47);
  });

  it("hides a series when its toggle is off", () => {
    const { container } = render(<RunChart series={series} show={{ elev: true, pace: false, hr: true }} hasElev hasHr />);
    // Pace off ⇒ its sky-blue curve is gone; HR (red) remains.
    expect(container.querySelector(`path.recharts-curve[stroke="${PACE}"]`)).toBeNull();
    expect(container.querySelector(`path.recharts-curve[stroke="${HR}"]`)).toBeTruthy();
    expect(container.querySelector(`path.recharts-curve[stroke="${ELEV}"]`)).toBeTruthy();
  });

  it("never renders the HR series when the run has no HR trace", () => {
    const { container } = render(<RunChart series={series} show={ALL} hasElev hasHr={false} />);
    expect(container.querySelector(`path.recharts-curve[stroke="${HR}"]`)).toBeNull();
    expect(container.querySelectorAll(".recharts-line").length).toBe(1); // pace only
  });

  it("still renders with an onCursor handler attached", () => {
    // The chart→map link wires onMouseMove/onClick/onMouseLeave; recharts mouse
    // geometry is flaky in jsdom, so this just asserts the prop is accepted and
    // the chart renders (the index→geo guarantee is covered by the pure test below).
    const { container } = render(<RunChart series={series} show={ALL} hasElev hasHr onCursor={() => {}} />);
    expect(container.querySelectorAll(".recharts-area").length).toBe(1);
    expect(container.querySelectorAll(".recharts-line").length).toBe(2);
  });
});

describe("Readout", () => {
  const row: RunSeriesRow = { distKm: 1.2, tSec: 360, elevM: 110, paceSecPerKm: 300, hr: 150 };

  it("formats distance, pace, elevation and HR for the active point", () => {
    const { container } = render(<Readout row={row} hasHr hasElev />);
    const text = container.textContent || "";
    expect(text).toContain("1.20 km");
    expect(text).toContain("5:00/km");
    expect(text).toContain("110 m");
    expect(text).toContain("150 bpm");
  });

  it("omits HR when hasHr is false and elevation when hasElev is false", () => {
    const { container } = render(<Readout row={row} hasHr={false} hasElev={false} />);
    const text = container.textContent || "";
    expect(text).toContain("5:00/km");
    expect(text).not.toContain("bpm");
    expect(text).not.toContain("110 m");
  });

  it("renders the hint (no layout-shifting emptiness) when no point is active", () => {
    const { container } = render(<Readout row={null} hasHr hasElev />);
    expect(container.textContent).toContain("Hover or tap the chart");
  });
});

describe("activeIndexFromChartState (recharts v3 stringly-typed index)", () => {
  // recharts 3.x returns activeTooltipIndex as String(clampedIndex) for
  // Line/Area/Composed charts, so a numeric-only check silently breaks the link.
  it("coerces a numeric string index to a number", () => {
    expect(activeIndexFromChartState({ activeTooltipIndex: "5" })).toBe(5);
  });
  it("accepts a real number index", () => {
    expect(activeIndexFromChartState({ activeTooltipIndex: 3 })).toBe(3);
  });
  it("returns null for absent / empty / non-numeric state", () => {
    expect(activeIndexFromChartState(null)).toBeNull();
    expect(activeIndexFromChartState(undefined)).toBeNull();
    expect(activeIndexFromChartState({})).toBeNull();
    expect(activeIndexFromChartState({ activeTooltipIndex: "" })).toBeNull();
    expect(activeIndexFromChartState({ activeTooltipIndex: "x" })).toBeNull();
    expect(activeIndexFromChartState({ activeTooltipIndex: null })).toBeNull();
  });
});

describe("chart↔map index alignment", () => {
  it("buildRunSeries and flattenTrack stay 1:1 in length and order across a gap", () => {
    // A gap marker (null) breaks the track; both helpers must skip it identically,
    // or the chart hover would highlight the wrong geographic point.
    const pts: TrackPointOrGap[] = [
      [48.000, 2.000, 1000, 100],
      [48.001, 2.000, 2000, 101],
      null, // GPS lost
      [48.002, 2.000, 3000, 102],
    ];
    const rows = buildRunSeries(pts);
    const flat = flattenTrack(pts);
    expect(rows.length).toBe(flat.length);
    expect(rows.length).toBe(3); // the gap is dropped, not emitted as a row
    rows.forEach((r, i) => {
      expect(r.distKm).toBeCloseTo(flat[i].cumKm, 6);
      expect(r.elevM).toBe(flat[i].alt);
    });
  });
});
