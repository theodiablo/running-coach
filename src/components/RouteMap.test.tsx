import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

// Minimal Leaflet stand-in: every layer records the calls we assert on, and the
// map is a no-op sink. Only what RouteMap touches is implemented. Hoisted so the
// vi.mock factory (which runs before module init) can reach it.
const { polylines, makePolyline, marker } = vi.hoisted(() => {
  const polylines: { setLatLngs: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }[] = [];
  const makePolyline = (coords: unknown[]) => {
    const p = {
      coords,
      setLatLngs: vi.fn((next: unknown[]) => { p.coords = next; return p; }),
      remove: vi.fn(),
      addTo: () => p,
      on: () => p,
      bindTooltip: () => p,
    };
    polylines.push(p);
    return p;
  };
  const marker = () => {
    const m = { setLatLng: () => m, setIcon: () => m, remove: vi.fn(), addTo: () => m };
    return m;
  };
  return { polylines, makePolyline, marker };
});

// The tile layer is a separate module (IndexedDB-backed cache); its behavior
// has its own test — here it just needs to attach without touching the mock map.
vi.mock("./cachedTileLayer", () => ({ cachedTileLayer: () => ({ addTo: vi.fn() }) }));

vi.mock("leaflet", () => {
  const map = {
    setView: () => map,
    getZoom: () => 15,
    fitBounds: () => map,
    addControl: () => map,
    removeControl: () => map,
    createPane: () => document.createElement("div"),
    getPane: () => document.createElement("div"),
    on: () => map,
    off: () => map,
    remove: () => map,
    invalidateSize: () => map,
    dragging: { enable: () => {}, disable: () => {} },
    touchZoom: { enable: () => {}, disable: () => {} },
    doubleClickZoom: { enable: () => {}, disable: () => {} },
    scrollWheelZoom: { enable: () => {}, disable: () => {} },
    boxZoom: { enable: () => {}, disable: () => {} },
    keyboard: { enable: () => {}, disable: () => {} },
    tap: { enable: () => {}, disable: () => {} },
  };
  const tile = { addTo: () => tile };
  return {
    default: {
      map: () => map,
      tileLayer: () => tile,
      polyline: (coords: unknown[]) => makePolyline(coords),
      marker,
      circle: () => ({ addTo: () => ({}), remove: vi.fn() }),
      divIcon: () => ({}),
      latLngBounds: () => ({ pad: () => ({}) }),
      control: { zoom: () => ({}) },
    },
  };
});

import { RouteMap } from "./RouteMap";

// [lat, lng, t, alt]; null is a gap marker.
const pt = (n: number) => [1 + n / 1000, 2 + n / 1000, 1000 + n * 2000, 10] as [number, number, number, number];

beforeEach(() => { polylines.length = 0; });
afterEach(cleanup);

describe("RouteMap track drawing", () => {
  it("grows the live track in place instead of rebuilding the polyline", () => {
    const { rerender } = render(<RouteMap points={[pt(0), pt(1), pt(2)]} />);
    expect(polylines).toHaveLength(1); // one segment, no gaps
    const line = polylines[0];

    // A GPS fix lands: same segment count, so the existing path is mutated.
    rerender(<RouteMap points={[pt(0), pt(1), pt(2), pt(3)]} />);
    expect(polylines).toHaveLength(1);
    expect(line.setLatLngs).toHaveBeenCalledTimes(1);
    expect(line.remove).not.toHaveBeenCalled();
    expect((line.setLatLngs.mock.calls[0][0] as unknown[])).toHaveLength(4);
  });

  it("rebuilds when a gap splits the track into a new segment", () => {
    const { rerender } = render(<RouteMap points={[pt(0), pt(1)]} />);
    expect(polylines).toHaveLength(1);
    const first = polylines[0];

    // A gap marker adds a second segment plus the dashed bridge between them,
    // so the layer count changes and reuse must not be attempted.
    rerender(<RouteMap points={[pt(0), pt(1), null, pt(2), pt(3)]} />);
    expect(first.remove).toHaveBeenCalled();
    // 1 stale + 2 segments + 1 bridge.
    expect(polylines).toHaveLength(4);
  });
});
