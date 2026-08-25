import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, screen } from "@testing-library/react";

// Minimal Leaflet stand-in: every layer records the calls we assert on, and the
// map is a no-op sink. Only what RouteMap touches is implemented. Hoisted so the
// vi.mock factory (which runs before module init) can reach it.
const { polylines, makePolyline, marker, mapCalls, mapHandlers } = vi.hoisted(() => {
  const mapCalls = { invalidateSize: 0, fitBounds: 0, setView: 0 };
  const mapHandlers: Record<string, (() => void)[]> = {};
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
  return { polylines, makePolyline, marker, mapCalls, mapHandlers };
});

// The tile layer is a separate module (IndexedDB-backed cache); its behavior
// has its own test — here it just needs to attach without touching the mock map.
vi.mock("./cachedTileLayer", () => ({ cachedTileLayer: () => ({ addTo: vi.fn() }) }));

vi.mock("leaflet", () => {
  const map = {
    setView: () => { mapCalls.setView++; return map; },
    getZoom: () => 15,
    fitBounds: () => { mapCalls.fitBounds++; return map; },
    addControl: () => map,
    removeControl: () => map,
    createPane: () => document.createElement("div"),
    getPane: () => document.createElement("div"),
    on: (ev: string, cb: () => void) => { (mapHandlers[ev] ||= []).push(cb); return map; },
    off: (ev: string, cb: () => void) => {
      mapHandlers[ev] = (mapHandlers[ev] || []).filter(h => h !== cb);
      return map;
    },
    remove: () => map,
    invalidateSize: () => { mapCalls.invalidateSize++; return map; },
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

beforeEach(() => {
  polylines.length = 0;
  Object.keys(mapHandlers).forEach(k => delete mapHandlers[k]);
  mapCalls.invalidateSize = 0;
  mapCalls.fitBounds = 0;
  mapCalls.setView = 0;
});
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

// jsdom has neither layout nor ResizeObserver: this stub hands the test the
// observer callback so a resize can be fired by hand, with clientWidth/Height
// patched to the box's new "size".
const resizeCbs: (() => void)[] = [];
function installResizeObserver() {
  resizeCbs.length = 0;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(cb: () => void) { resizeCbs.push(cb); }
    observe() {}
    disconnect() {}
  };
}
const resizeTo = (el: HTMLElement, w: number, h: number) => {
  Object.defineProperty(el, "clientWidth", { value: w, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: h, configurable: true });
  act(() => { resizeCbs.forEach(cb => cb()); });
};
// The map element itself, down the wrapper > shell > map nesting.
const mapEl = (c: HTMLElement) =>
  c.firstElementChild!.firstElementChild!.firstElementChild as HTMLElement;

describe("RouteMap resizing", () => {
  beforeEach(installResizeObserver);

  // Leaflet caches the container size and refreshes it only on a window resize,
  // so a map whose own box changes (the tracker's panel growing when a run ends)
  // keeps framing the route into the box it no longer has — hiding the bottom of
  // the track under the edge.
  it("re-measures and re-frames the route when its box changes size", () => {
    const { container } = render(<RouteMap points={[pt(0), pt(1), pt(2)]} />);
    const fitsBefore = mapCalls.fitBounds;
    resizeTo(mapEl(container), 320, 160);
    expect(mapCalls.invalidateSize).toBe(1);
    expect(mapCalls.fitBounds).toBe(fitsBefore + 1);
  });

  it("leaves the camera alone once the user has panned", () => {
    const { container } = render(<RouteMap points={[pt(0), pt(1), pt(2)]} />);
    act(() => { mapHandlers.dragstart.forEach(h => h()); });
    const fitsBefore = mapCalls.fitBounds;
    resizeTo(mapEl(container), 320, 160);
    expect(mapCalls.invalidateSize).toBe(1);     // the size is still refreshed
    expect(mapCalls.fitBounds).toBe(fitsBefore); // but the view is left as they put it
  });
});

describe("RouteMap full screen", () => {
  beforeEach(installResizeObserver);

  it("is opt-in", () => {
    render(<RouteMap points={[pt(0)]} />);
    expect(screen.queryByLabelText("Show the map full screen")).toBeNull();
  });

  it("lifts the map over the viewport and back without remounting it", () => {
    const onExpandedChange = vi.fn();
    const { container } = render(
      <RouteMap points={[pt(0), pt(1)]} expandable onExpandedChange={onExpandedChange} className="h-56" />);
    const el = mapEl(container);
    const shell = el.parentElement as HTMLElement;
    expect(shell.style.position).toBe("absolute");

    act(() => { screen.getByLabelText("Show the map full screen").click(); });
    expect(shell.style.position).toBe("fixed");
    // The same element throughout: Leaflet is never torn down by the trip.
    expect(mapEl(container)).toBe(el);
    expect(onExpandedChange).toHaveBeenLastCalledWith(true);

    act(() => { screen.getByLabelText("Leave full screen").click(); });
    expect(shell.style.position).toBe("absolute");
    expect(onExpandedChange).toHaveBeenLastCalledWith(false);
  });
});
