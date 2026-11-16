import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MAP_ATTRIBUTION, MAP_TILE_URL } from "../../constants";
import { cachedTileLayer } from "../cachedTileLayer";

const PIN = L.divIcon({
  className: "",
  html: `<svg width="20" height="29" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))">
    <path d="M14 0C6.268 0 0 6.268 0 14c0 10.5 14 26 14 26s14-15.5 14-26C28 6.268 21.732 0 14 0z" fill="#f97316" stroke="#fff" stroke-width="1.5"/>
    <circle cx="14" cy="14" r="5" fill="#fff"/></svg>`,
  iconSize: [20, 29],
  iconAnchor: [10, 29],
});

// A still map of where a race starts: no pan, zoom or tap, so it never fights the sheet's scroll.
export function RaceMiniMap({ lat, lng, label }: { lat: number; lng: number; label: string }) {
  const el = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!el.current) return;
    const map = L.map(el.current, {
      zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
      boxZoom: false, keyboard: false, touchZoom: false, attributionControl: true,
    }).setView([lat, lng], 12);
    cachedTileLayer(MAP_TILE_URL, { attribution: MAP_ATTRIBUTION, maxZoom: 20 }).addTo(map);
    L.marker([lat, lng], { icon: PIN, interactive: false, keyboard: false }).addTo(map);
    return () => { map.remove(); };
  }, [lat, lng]);
  return <div ref={el} role="img" aria-label={label} className="h-36 rounded-xl overflow-hidden border border-slate-700 bg-slate-800 z-0 relative"/>;
}
