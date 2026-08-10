import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDismissable } from "../hooks/useDismissable";
import L, { type LeafletEvent, type LatLngTuple, type Map, type Marker } from "leaflet";
import "leaflet/dist/leaflet.css";
import { Loader, MapPin, Search, X } from "lucide-react";
import { INPUT_CLS, MAP_ATTRIBUTION, MAP_KEY, MAP_TILE_URL } from "../constants";
import { cachedTileLayer } from "./cachedTileLayer";
import { geoSource } from "../geo/source";
import { geocodePlace } from "../utils/geocode";

type LatLng = { lat: number; lng: number };

type LocationPickerProps = {
  initial?: LatLng | null;
  geocodeQuery?: string;
  onConfirm: (point: LatLng) => void;
  onCancel: () => void;
};

const WORLD_CENTER: LatLngTuple = [20, 0];
const WORLD_ZOOM = 2;
const PICKED_ZOOM = 13;
const SEARCH_DEBOUNCE_MS = 500;

// Inline SVG teardrop pin (divIcon) instead of Leaflet's default L.Icon — the
// default references marker-icon-2x.png/marker-icon.png/marker-shadow.png by
// URL, which don't resolve under Vite's bundling and render as a broken image.
// Anchored at the tip so it points exactly at the picked coordinate.
const PIN_ICON = L.divIcon({
  className: "",
  html: `<svg width="22" height="32" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))">
    <path d="M14 0C6.268 0 0 6.268 0 14c0 10.5 14 26 14 26s14-15.5 14-26C28 6.268 21.732 0 14 0z" fill="#f97316" stroke="#fff" stroke-width="1.5"/>
    <circle cx="14" cy="14" r="5" fill="#fff"/>
  </svg>`,
  iconSize: [22, 32],
  iconAnchor: [11, 32],
});

// Full-screen tap/drag map picker for a single point. Built for "Add a race":
// a contributor is rarely standing where the race actually happens, so a
// "use my current location" button alone produces wrong coordinates for the
// shared catalogue. This lets them place a pin directly instead — opening
// centered on `initial` (an already-set location) or a one-off geocode of
// `geocodeQuery` (the city/country they already typed), falling back to the
// world view. "Jump to my current location" is offered too, but only as one
// more way to seed the pin, never the only option.
export function LocationPicker({ initial, geocodeQuery, onConfirm, onCancel }: LocationPickerProps) {
  const { t } = useTranslation();
  useDismissable(true, onCancel);
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const [picked, setPicked] = useState<LatLng | null>(initial || null);
  const [locating, setLocating] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchMiss, setSearchMiss] = useState(false);
  const searchSeqRef = useRef(0);

  const placeMarker = (lat: number, lng: number) => {
    const map = mapRef.current;
    if (!map) return;
    if (markerRef.current) markerRef.current.setLatLng([lat, lng]);
    else {
      markerRef.current = L.marker([lat, lng], { draggable: true, icon: PIN_ICON }).addTo(map);
      markerRef.current.on("dragend", () => {
        const ll = markerRef.current?.getLatLng();
        if (!ll) return;
        setPicked({ lat: ll.lat, lng: ll.lng });
      });
    }
    setPicked({ lat, lng });
  };

  useEffect(() => {
    if (!elRef.current) return;
    const map = L.map(elRef.current, { zoomControl: true }).setView(
      initial ? [initial.lat, initial.lng] : WORLD_CENTER,
      initial ? PICKED_ZOOM : WORLD_ZOOM,
    );
    cachedTileLayer(MAP_TILE_URL, { attribution: MAP_ATTRIBUTION, maxZoom: 20 }).addTo(map);
    map.on("click", (e: LeafletEvent) => placeMarker(e.latlng.lat, e.latlng.lng));
    mapRef.current = map;
    if (initial) placeMarker(initial.lat, initial.lng);
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // Map is created once; initial only seeds the opening view/pin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recenter (but don't place a pin) once the city/country the contributor
  // already typed resolves to coordinates — skipped if they've already set an
  // explicit location, so re-opening the picker never fights their edit.
  useEffect(() => {
    if (initial || !geocodeQuery?.trim()) return;
    let cancelled = false;
    geocodePlace(geocodeQuery).then((center) => {
      if (!cancelled && center && mapRef.current) {
        mapRef.current.setView([center.lat, center.lng], PICKED_ZOOM, { animate: false });
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Address/city search box — debounced forward geocode via the same MapTiler
  // endpoint, so a contributor can type an exact address instead of only
  // tapping/dragging on a (possibly far-zoomed-out) map. A hit both recenters
  // AND places the pin (like "jump to my current location"); the user can
  // still drag to fine-tune. `searchSeqRef` drops a stale response that
  // resolves after a newer keystroke has already fired its own search.
  // searching/searchMiss are cleared synchronously in onQueryChange (not here)
  // so this effect never calls setState outside its async timeout callback.
  useEffect(() => {
    if (!query.trim()) return;
    const seq = ++searchSeqRef.current;
    const t = setTimeout(() => {
      setSearching(true);
      geocodePlace(query).then((center) => {
        if (searchSeqRef.current !== seq) return; // superseded by a newer search
        setSearching(false);
        if (center) {
          mapRef.current?.setView([center.lat, center.lng], PICKED_ZOOM);
          placeMarker(center.lat, center.lng);
        } else {
          setSearchMiss(true);
        }
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const onQueryChange = (v: string) => {
    setQuery(v);
    setSearching(false);
    setSearchMiss(false);
  };

  const useMyLocation = async () => {
    setLocating(true);
    try {
      const p = await geoSource.getCurrentPosition() as LatLng;
      mapRef.current?.setView([p.lat, p.lng], PICKED_ZOOM, { animate: false });
      placeMarker(p.lat, p.lng);
    } catch { /* the map itself is the fallback — no need to surface this */ }
    finally { setLocating(false); }
  };

  return (
    <div className="fixed inset-0 bg-slate-900 z-[2000] flex flex-col animate-slide-up">
      <header className="flex items-center justify-between px-4 border-b border-slate-800 shrink-0"
        style={{ height: "calc(44px + var(--safe-top))", paddingTop: "var(--safe-top)" }}>
        <p className="text-sm font-semibold">{t("races.picker.title")}</p>
        <button onClick={onCancel} aria-label={t("common.close")} className="text-slate-400 hover:text-white p-1.5"><X size={18} /></button>
      </header>
      <div className="px-4 pt-2 shrink-0 relative">
        <Search size={16} className="absolute left-7 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
        <input value={query} onChange={e => onQueryChange(e.target.value)} placeholder={t("races.picker.searchPlaceholder")}
          className={INPUT_CLS + " pl-9 pr-9"} />
        {searching && <Loader size={14} className="animate-spin absolute right-7 top-1/2 -translate-y-1/2 text-slate-400" />}
      </div>
      {searchMiss && !searching && (
        <p className="text-[12px] text-red-400 px-4 pt-1 shrink-0">{t("races.picker.noMatch")}</p>
      )}
      <p className="text-[12px] text-slate-400 px-4 py-2 shrink-0">
        {t("races.picker.hint")}
      </p>
      <div className="flex-1 min-h-0 relative">
        <div ref={elRef} className="absolute inset-0" />
        {!MAP_KEY && (
          <div className="absolute bottom-2 left-2 right-2 z-[400] text-[10px] text-amber-300 bg-slate-900/80 rounded px-1.5 py-0.5 pointer-events-none">
            {t("races.picker.noKey")}
          </div>
        )}
      </div>
      <div className="p-4 space-y-2 border-t border-slate-800 shrink-0" style={{ paddingBottom: "calc(1rem + var(--safe-bottom))" }}>
        <button onClick={useMyLocation} disabled={locating}
          className="w-full flex items-center justify-center gap-2 bg-slate-700 hover:bg-slate-600 text-slate-200 py-2.5 rounded-xl text-sm font-semibold transition-colors disabled:opacity-60">
          {locating ? <Loader size={14} className="animate-spin" /> : <MapPin size={14} />}
          {t("races.picker.jump")}
        </button>
        <div className="flex gap-2">
          <button onClick={onCancel}
            className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-200 py-2.5 rounded-xl text-sm font-semibold transition-colors">
            {t("common.cancel")}
          </button>
          <button onClick={() => picked && onConfirm(picked)} disabled={!picked}
            className="flex-1 bg-orange-500 hover:bg-orange-600 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors disabled:opacity-50">
            {t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
