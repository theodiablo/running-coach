// The follow list's map: every runner as a labelled head, and only the focused
// runner's route — the batch read carries heads, not traces, so that is all
// there is to draw (and on a shared course, overlapping lines hid each other
// anyway). Plain tile layer: the public page stores nothing it wasn't asked to.
//
// Labels are viewer-typed text, so markers are built as DOM nodes with
// textContent and never as an HTML string.

import { useEffect, useRef } from "react";
import L, { type DivIcon, type LatLngExpression, type Map, type Marker, type Polyline } from "leaflet";
import "leaflet/dist/leaflet.css";
import { MAP_ATTRIBUTION, MAP_TILE_URL } from "../constants";
import { haversineM, segments, type TrackPointOrGap } from "../utils/geo";

export type MapRunner = {
  token: string;
  color: string;
  initial: string;
  label: string;
  head: [number, number] | null;
  // Not moving any more (finished) or nothing to show: drawn hollow.
  hollow: boolean;
  warn: boolean;
};

// Past this spread, "fit everyone" frames a country, not a race.
const MAX_FIT_KM = 60;

function headIcon(r: MapRunner, focused: boolean): DivIcon {
  const size = focused ? 26 : 22;
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:relative;display:flex;flex-direction:column;align-items:center;pointer-events:auto;cursor:pointer";
  const chip = document.createElement("div");
  chip.textContent = r.label;
  chip.style.cssText = `position:absolute;bottom:${size + 4}px;white-space:nowrap;font:600 11px system-ui,sans-serif;color:#f1f5f9;`
    + `background:#0f172a;border:1px solid ${r.warn ? "#fbbf24" : r.color};border-radius:9999px;padding:1px 7px`;
  const dot = document.createElement("div");
  dot.textContent = r.initial;
  dot.style.cssText = `width:${size}px;height:${size}px;border-radius:9999px;display:grid;place-items:center;`
    + `font:800 ${focused ? 12 : 11}px system-ui,sans-serif;box-shadow:0 0 0 2px #0f172a;`
    + (r.hollow ? `background:#0f172a;color:${r.color};border:2px solid ${r.color}` : `background:${r.color};color:#0f172a`);
  wrap.append(chip, dot);
  return L.divIcon({ className: "", html: wrap, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

export function MultiRunnerMap(
  { runners, focus, track, onPick, refit }:
  {
    runners: MapRunner[];
    focus: string | null;
    track: TrackPointOrGap[] | null;
    onPick: (token: string) => void;
    // Bumped by the caller to re-frame (the "Everyone" button, a new focus).
    refit: number;
  },
) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const markersRef = useRef(new globalThis.Map<string, Marker>());
  const linesRef = useRef<Polyline[]>([]);
  const userMovedRef = useRef(false);
  const programmaticRef = useRef(false);
  const onPickRef = useRef(onPick);
  useEffect(() => { onPickRef.current = onPick; });

  useEffect(() => {
    if (!elRef.current) return;
    const map = L.map(elRef.current, { zoomControl: true, attributionControl: true }).setView([43.3, -1.9], 11);
    L.tileLayer(MAP_TILE_URL, { attribution: MAP_ATTRIBUTION, maxZoom: 20 }).addTo(map);
    const onGesture = () => { if (!programmaticRef.current) userMovedRef.current = true; };
    map.on("dragstart", onGesture);
    map.on("zoomstart", onGesture);
    mapRef.current = map;
    const markers = markersRef.current;
    return () => {
      map.remove();
      mapRef.current = null;
      markers.clear();
      linesRef.current = [];
    };
  }, []);

  // Heads.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const live = new Set<string>();
    for (const r of runners) {
      if (!r.head) continue;
      live.add(r.token);
      const icon = headIcon(r, r.token === focus);
      const existing = markersRef.current.get(r.token);
      if (existing) existing.setLatLng(r.head).setIcon(icon).setZIndexOffset(r.token === focus ? 1000 : 0);
      else {
        const m = L.marker(r.head, { icon, keyboard: false, zIndexOffset: r.token === focus ? 1000 : 0 }).addTo(map);
        const token = r.token;
        m.on("click", () => onPickRef.current(token));
        markersRef.current.set(r.token, m);
      }
    }
    for (const [token, m] of markersRef.current) if (!live.has(token)) { m.remove(); markersRef.current.delete(token); }
  }, [runners, focus]);

  // The focused route, under the heads.
  const color = runners.find(r => r.token === focus)?.color ?? "#a78bfa";
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    linesRef.current.forEach(l => l.remove());
    linesRef.current = [];
    if (!track) return;
    let prev: LatLngExpression | null = null;
    for (const seg of (segments(track) as LatLngExpression[][]).filter(s => s.length)) {
      if (prev) linesRef.current.push(L.polyline([prev, seg[0]], { color, weight: 3, opacity: 0.5, dashArray: "4 8", interactive: false }).addTo(map));
      linesRef.current.push(L.polyline(seg, { color, weight: 5, opacity: 0.95, interactive: false }).addTo(map));
      prev = seg[seg.length - 1];
    }
  }, [track, color]);

  // Camera: the focused route if there is one, else every head — unless the
  // viewer has taken over, until the caller asks for a re-frame.
  const lastRefit = useRef(refit);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (lastRefit.current !== refit) { lastRefit.current = refit; userMovedRef.current = false; }
    if (userMovedRef.current) return;
    const focused = runners.find(r => r.token === focus);
    let pts: LatLngExpression[] = [];
    if (focus && track) pts = (segments(track) as LatLngExpression[][]).flat();
    if (!pts.length && focused?.head) pts = [focused.head];
    if (!pts.length) {
      const heads = runners.filter(r => r.head).map(r => r.head as [number, number]);
      const lats = heads.map(h => h[0]), lngs = heads.map(h => h[1]);
      const spreadKm = heads.length > 1
        ? haversineM({ lat: Math.min(...lats), lng: Math.min(...lngs) }, { lat: Math.max(...lats), lng: Math.max(...lngs) }) / 1000 : 0;
      // Runners in different cities: frame the first one instead of a continent.
      pts = spreadKm > MAX_FIT_KM ? [heads[0]] : heads;
    }
    if (!pts.length) return;
    programmaticRef.current = true;
    if (pts.length === 1) map.setView(pts[0], Math.max(map.getZoom(), 15), { animate: false });
    else map.fitBounds(L.latLngBounds(pts).pad(0.2), { animate: false });
    programmaticRef.current = false;
  }, [runners, focus, track, refit]);

  // Leaflet only notices window resizes; the panel beside it can change too.
  useEffect(() => {
    const el = elRef.current;
    const map = mapRef.current;
    if (!el || !map || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      programmaticRef.current = true;
      map.invalidateSize({ animate: false });
      programmaticRef.current = false;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="absolute inset-0" style={{ isolation: "isolate" }}>
      <div ref={elRef} className="absolute inset-0" />
    </div>
  );
}
