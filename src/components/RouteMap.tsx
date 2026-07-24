import { useEffect, useRef, useCallback } from "react";
import type { CSSProperties, MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import L, { type Circle, type Control, type LatLngExpression, type Map, type Marker, type Polyline } from "leaflet";
import "leaflet/dist/leaflet.css";
import { MAP_ATTRIBUTION, MAP_KEY, MAP_TILE_URL } from "../constants";
import { segments } from "../utils/geo";

// Imperative Leaflet wrapper. We drive the map directly via refs (no
// react-leaflet) so the polyline/marker update cheaply at GPS frequency without
// re-rendering React, and to avoid a React-version-coupled dependency.
//
// `points` is the tracker tuple array ([lat,lng,t,alt], null = gap). `follow`
// recenters on the latest fix while live — nav-app style: the user can pan/zoom
// to take over (which suspends follow, reported via `onFollowingChange`), and a
// bump of `recenterSignal` snaps back to the current position at a default zoom
// and re-arms follow. `endpoints` swaps the live "head" dot for distinct
// start/finish markers (finished-run view), `highlight` pins a marker at an
// externally-driven point (chart hover), and `onPick` reports map taps back.
export type TrackPoint = [number, number, number, number | null] | LatLngExpression;
type PreviewLocation = { lat: number; lng: number; acc?: number | null };
type LatLng = { lat: number; lng: number };
// A non-recorded "guide" line drawn UNDER the recorded track (own low-z pane):
// the route-finder's suggested loops and the live tracker's chosen planned line.
// Additive and inert by default so existing callers are untouched.
// Guide geometry is looser than the recorded-track tuple: suggested loops are
// [lat,lng,alt] 3-tuples (no timestamp), and only lat/lng are read for drawing.
export type GuidePoint = readonly (number | null)[] | null;
export type RouteGuide = {
  points: GuidePoint[];
  color?: string;
  dashed?: boolean;
  opacity?: number;
  weight?: number;
  id?: string;     // when set (+ onGuidePick), the line is tappable to select it
  label?: string;  // when set, a permanent tooltip on the line (e.g. the selected route's stats)
};
type RouteMapProps = {
  points?: (TrackPoint | null)[];
  follow?: boolean;
  interactive?: boolean;
  location?: PreviewLocation | null;
  className?: string;
  style?: CSSProperties;
  endpoints?: boolean;
  highlight?: LatLng | null;
  onPick?: (loc: LatLng) => void;
  recenterSignal?: number;
  onFollowingChange?: (following: boolean) => void;
  // Single planned line (live tracker handoff): sky, dashed, camera untouched.
  guidePoints?: GuidePoint[] | null;
  // Multiple styled guide lines (route-finder candidates).
  guides?: RouteGuide[];
  // Frame the guide lines when there is no recorded track yet (finder preview).
  fitGuides?: boolean;
  // Report a tap on a guide line (by its RouteGuide.id) so the map itself can
  // select a candidate, not just the cards.
  onGuidePick?: (id: string) => void;
};

const GUIDE_COLOR = "#38bdf8"; // sky — visually distinct from the orange record line

type ToggleKey = "dragging" | "scrollWheelZoom" | "doubleClickZoom" | "boxZoom" | "keyboard" | "touchZoom" | "tap";

const LIVE_DEFAULT_ZOOM = 16; // recenter/snap-back zoom for the live map

export function RouteMap({ points = [], follow = false, interactive = true, location = null, className = "", style,
  endpoints = false, highlight = null, onPick, recenterSignal = 0, onFollowingChange,
  guidePoints = null, guides, fitGuides = false, onGuidePick }: RouteMapProps) {
  const { t } = useTranslation();
  const onGuidePickRef = useRef(onGuidePick);
  useEffect(() => { onGuidePickRef.current = onGuidePick; });
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const linesRef = useRef<Polyline[]>([]);
  const guideLinesRef = useRef<Polyline[]>([]);
  const dotRef = useRef<Marker | null>(null);
  const startRef = useRef<Marker | null>(null);      // start-of-route marker (endpoints mode)
  const finishRef = useRef<Marker | null>(null);     // finish-of-route marker (endpoints mode)
  const highlightRef = useRef<Marker | null>(null);  // externally-driven point highlight
  const headRef = useRef<LatLngExpression | null>(null); // latest head, read by the recenter effect
  const locDotRef = useRef<Marker | null>(null);     // preview position dot (before recording)
  const locCircleRef = useRef<Circle | null>(null);  // accuracy circle around the preview dot
  const locCenteredRef = useRef(false);
  const zoomCtrlRef = useRef<Control | null>(null);
  const followingRef = useRef(true);                 // nav-follow armed & not user-suspended
  const programmaticRef = useRef(false);             // guards our own setView from the gesture handler
  const onFollowingChangeRef = useRef(onFollowingChange);
  useEffect(() => { onFollowingChangeRef.current = onFollowingChange; });

  // Flip the internal follow state and notify the parent only on a real change,
  // so the recenter button can appear/disappear without redundant re-renders.
  const emitFollowing = useCallback((v: boolean) => {
    if (followingRef.current === v) return;
    followingRef.current = v;
    onFollowingChangeRef.current?.(v);
  }, []);

  // Our own recenters must not read as a user gesture (which would suspend
  // follow). setView({animate:false}) runs synchronously, so bracketing it with
  // this flag reliably covers the move/zoom events it fires.
  const programmaticSetView = useCallback((ll: LatLngExpression, zoom: number) => {
    const map = mapRef.current;
    if (!map) return;
    programmaticRef.current = true;
    map.setView(ll, zoom, { animate: false });
    programmaticRef.current = false;
  }, []);

  // Create the map once. Recreating it whenever interactivity changes would snap
  // the view back to the world map (it happened on every Start) — so interactive
  // is toggled in a separate effect below instead.
  useEffect(() => {
    if (!elRef.current) return;
    const map = L.map(elRef.current, {
      zoomControl: false,
      attributionControl: true,
    }).setView([0, 0], 2);
    L.tileLayer(MAP_TILE_URL, { attribution: MAP_ATTRIBUTION, maxZoom: 20 }).addTo(map);
    // A dedicated low-z pane so guide lines (suggested/planned loops) always sit
    // UNDER the recorded track (overlayPane z=400) and its markers, no matter the
    // order the two effects run in.
    map.createPane("guide");
    const guidePane = map.getPane("guide");
    if (guidePane) guidePane.style.zIndex = "390";
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      linesRef.current = [];
      guideLinesRef.current = [];
      dotRef.current = null;
      startRef.current = null;
      finishRef.current = null;
      highlightRef.current = null;
      headRef.current = null;
      locDotRef.current = null;
      locCircleRef.current = null;
      zoomCtrlRef.current = null;
      locCenteredRef.current = false;
    };
  }, []);

  // Nav-follow: a manual pan or zoom suspends auto-follow so the map stays where
  // the user put it. `dragstart` is always user-initiated; `zoomstart` also fires
  // for our own programmatic zoom, hence the programmatic guard.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onGesture = () => { if (!programmaticRef.current) emitFollowing(false); };
    map.on("dragstart", onGesture);
    map.on("zoomstart", onGesture);
    return () => { map.off("dragstart", onGesture); map.off("zoomstart", onGesture); };
  }, [emitFollowing]);

  // Re-arm follow whenever it's (re)enabled — e.g. Start/Resume after the user
  // panned the idle preview — so a prior manual pan doesn't leave the live map
  // stuck off-centre.
  useEffect(() => {
    if (follow) emitFollowing(true);
  }, [follow, emitFollowing]);

  // Enable/disable pan-zoom without tearing the map down (which would reset the
  // view). The live map stays interactive (nav-follow handles centring); History
  // and the run-detail map are interactive too. `interactive={false}` is only for
  // callers that want a static preview.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    (["dragging", "scrollWheelZoom", "doubleClickZoom", "boxZoom", "keyboard", "touchZoom", "tap"] as ToggleKey[])
      .forEach(h => map[h] && map[h][interactive ? "enable" : "disable"]());
    if (interactive && !zoomCtrlRef.current) {
      zoomCtrlRef.current = L.control.zoom();
      map.addControl(zoomCtrlRef.current);
    } else if (!interactive && zoomCtrlRef.current) {
      map.removeControl(zoomCtrlRef.current);
      zoomCtrlRef.current = null;
    }
  }, [interactive]);

  // Redraw the track whenever points change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    linesRef.current.forEach(l => l.remove());
    linesRef.current = [];
    const dot = (bg: string, size = 14) => L.divIcon({
      className: "",
      html: `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:${bg};border:2px solid #fff;box-shadow:0 0 0 2px rgba(15,23,42,.35)"></div>`,
      iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    });
    const place = (ref: MutableRefObject<Marker | null>, ll: LatLngExpression, icon: unknown) => {
      if (ref.current) ref.current.setLatLng(ll).setIcon(icon);
      else ref.current = L.marker(ll, { icon, interactive: false }).addTo(map);
    };
    const drop = (ref: MutableRefObject<Marker | null>) => { if (ref.current) { ref.current.remove(); ref.current = null; } };

    const segs = segments(points) as LatLngExpression[][];
    const all: LatLngExpression[] = [];
    let prevEnd: LatLngExpression | null = null;
    segs.forEach(seg => {
      if (!seg.length) return;
      // Bridge a gap (signal loss / suspended background) with a faded dashed line
      // so the route reads as one continuous run while still marking the stretch we
      // didn't actually track — distinct from the solid, recorded segments.
      if (prevEnd) {
        const bridge = L.polyline([prevEnd, seg[0]], {
          color: "#f97316", weight: 3, opacity: 0.5, dashArray: "4 8",
        }).addTo(map);
        linesRef.current.push(bridge);
      }
      const line = L.polyline(seg, { color: "#f97316", weight: 4, opacity: 0.9 }).addTo(map);
      linesRef.current.push(line);
      all.push(...seg);
      prevEnd = seg[seg.length - 1];
    });

    // Head of the track = current position (live) or the last recorded point.
    const lastSeg = segs[segs.length - 1];
    const head = (lastSeg && lastSeg[lastSeg.length - 1]) || null;
    headRef.current = head;

    if (endpoints) {
      // Finished-run view: distinct start (green) + finish (checkered) markers.
      // The live "head" dot is suppressed so it doesn't stack on the finish.
      drop(dotRef);
      const start = segs[0] && segs[0][0];
      if (start) place(startRef, start, dot("#22c55e")); else drop(startRef);
      if (head) {
        const finishIcon = L.divIcon({
          className: "",
          html: '<div style="width:20px;height:20px;border-radius:6px;background:#fff;box-shadow:0 0 0 2px rgba(15,23,42,.35);display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);overflow:hidden">'
            + [0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => `<span style="background:${(i + Math.floor(i / 3)) % 2 ? "#0f172a" : "#fff"}"></span>`).join("")
            + "</div>",
          iconSize: [20, 20], iconAnchor: [10, 10],
        });
        place(finishRef, head, finishIcon);
      } else drop(finishRef);
    } else {
      // Live / preview / review: single orange current-position dot.
      drop(startRef);
      drop(finishRef);
      if (head) place(dotRef, head, dot("#f97316")); else drop(dotRef);
    }

    // Camera: while follow is armed AND not user-suspended, keep the head centred
    // (preserving the user's zoom). Otherwise, when not in follow mode, frame the
    // whole route. A user-suspended live map is left exactly where they put it.
    if (follow) {
      if (followingRef.current && head) programmaticSetView(head, Math.max(map.getZoom(), LIVE_DEFAULT_ZOOM));
    } else if (all.length) {
      // Guard as programmatic: fitBounds changes zoom (fires `zoomstart`), which
      // the gesture handler would otherwise read as a user pan and suspend follow
      // — spuriously showing the recenter button on tracking→paused.
      programmaticRef.current = true;
      map.fitBounds(L.latLngBounds(all).pad(0.15), { animate: false });
      programmaticRef.current = false;
    }
  }, [points, follow, endpoints, programmaticSetView]);

  // Guide lines (suggested loops / planned line) — drawn in the low-z "guide"
  // pane so they read as background under any recorded track. Keyed on a cheap
  // signature (segment count + endpoints) so it doesn't redraw on every unrelated
  // re-render, and it never touches the follow/recenter camera; `fitGuides` only
  // frames them while there's no recorded track (the finder's static preview).
  const normalizedGuides: RouteGuide[] = [
    ...(guidePoints?.length ? [{ points: guidePoints, color: GUIDE_COLOR, dashed: true, opacity: 0.9, weight: 4 }] : []),
    ...(guides ?? []),
  ];
  const coordSig = (p: unknown) => (Array.isArray(p) ? `${p[0]},${p[1]}` : "");
  // Geometry-only signature: which lines exist and where, ignoring styling. The
  // camera fit keys on THIS, so restyling (e.g. selecting a candidate, which only
  // flips colours/opacity) never re-fits and clobbers the user's pan/zoom.
  // A MIDPOINT is sampled alongside the endpoints because these guides are loops:
  // first ≈ last ≈ the origin for every candidate, so endpoints alone barely
  // differ between candidates — the midpoint is what actually distinguishes them.
  const guideGeomSig = normalizedGuides.map(g => {
    const pts = g.points;
    return `${pts.length}:${coordSig(pts[0])}:${coordSig(pts[pts.length >> 1])}:${coordSig(pts[pts.length - 1])}`;
  }).join("|");
  // Full signature adds the style fields (incl. weight) so a style-only change
  // still redraws the strokes.
  const guideStyleSig = normalizedGuides.map(g =>
    `${g.color ?? ""}:${g.dashed ? "d" : ""}:${g.opacity ?? ""}:${g.weight ?? ""}:${g.id ?? ""}:${g.label ?? ""}`).join("|");
  const guideSig = guideGeomSig + "|" + guideStyleSig;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    guideLinesRef.current.forEach(l => l.remove());
    guideLinesRef.current = [];
    normalizedGuides.forEach(g => {
      let labelled = false; // bind the tooltip to only the first drawn segment
      (segments(g.points) as LatLngExpression[][]).forEach(seg => {
        if (!seg.length) return;
        const line = L.polyline(seg, {
          pane: "guide",
          color: g.color ?? GUIDE_COLOR,
          weight: g.weight ?? 4,
          opacity: g.opacity ?? 0.9,
          ...(g.dashed ? { dashArray: "6 8" } : {}),
        }).addTo(map);
        guideLinesRef.current.push(line);
        if (g.label && !labelled) {
          line.bindTooltip(g.label, { permanent: true, direction: "top", className: "route-guide-tip", opacity: 1 });
          labelled = true;
        }
        // A fat transparent "hit" line on top so a candidate is easy to tap on
        // the map (a 4-6px stroke is a hard target). stroke-opacity:0 still
        // counts as painted, so it stays invisible yet clickable.
        if (g.id && onGuidePickRef.current) {
          const id = g.id;
          const hit = L.polyline(seg, { pane: "guide", color: "#000", weight: 20, opacity: 0 }).addTo(map);
          hit.on("click", () => onGuidePickRef.current?.(id));
          guideLinesRef.current.push(hit);
        }
      });
    });
    // Keyed on the signature (not the arrays) so live-run re-renders don't thrash
    // the guide layer; points.length is intentionally out of deps so the guide
    // isn't redrawn on every GPS fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideSig]);

  // Frame the guides — but ONLY when the guide GEOMETRY changes (a new candidate
  // set), never on a style-only restyle, and only while there's no recorded track
  // yet (the finder's static preview). Separate from the draw effect so selecting
  // a candidate doesn't re-fit and reset a zoom the user set.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitGuides || points.length) return;
    const allGuide: LatLngExpression[] = [];
    normalizedGuides.forEach(g => (segments(g.points) as LatLngExpression[][]).forEach(seg => allGuide.push(...seg)));
    if (!allGuide.length) return;
    programmaticRef.current = true;
    map.fitBounds(L.latLngBounds(allGuide).pad(0.2), { animate: false });
    programmaticRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideGeomSig, fitGuides]);

  // Externally-driven highlight (e.g. the run-detail chart hover). Keyed on the
  // primitive lat/lng, not the object, so it doesn't re-create the marker on every
  // unrelated re-render, and placed after the track effect so it layers on top.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (highlight) {
      const icon = L.divIcon({
        className: "",
        html: '<div style="position:relative;width:16px;height:16px">'
          + '<div class="route-highlight-ring" style="position:absolute;inset:0;border-radius:9999px;background:rgba(56,189,248,.45)"></div>'
          + '<div style="position:absolute;inset:3px;border-radius:9999px;background:#38bdf8;border:2px solid #fff;box-shadow:0 0 0 1px rgba(56,189,248,.6)"></div>'
          + '</div>',
        iconSize: [16, 16], iconAnchor: [8, 8],
      });
      if (highlightRef.current) highlightRef.current.setLatLng([highlight.lat, highlight.lng]).setIcon(icon);
      else highlightRef.current = L.marker([highlight.lat, highlight.lng], { icon, interactive: false }).addTo(map);
    } else if (highlightRef.current) {
      highlightRef.current.remove();
      highlightRef.current = null;
    }
    // Keyed on the primitive coords, not the `highlight` object, so an unchanged
    // point doesn't re-create the marker on every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.lat, highlight?.lng]);

  // Report map taps back to the caller (run-detail: map → chart cursor).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !onPick) return;
    const onClick = (e: { latlng: { lat: number; lng: number } }) => onPick({ lat: e.latlng.lat, lng: e.latlng.lng });
    map.on("click", onClick);
    return () => { map.off("click", onClick); };
  }, [onPick]);

  // Snap-back: a bump of `recenterSignal` (recenter button, or returning from a
  // locked screen) recentres on the current head at the default zoom and re-arms
  // follow. The initial mount (signal 0) is a no-op — there's no head yet.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (headRef.current) programmaticSetView(headRef.current, LIVE_DEFAULT_ZOOM);
    emitFollowing(true);
  }, [recenterSignal, emitFollowing, programmaticSetView]);

  // Preview the current location + an accuracy circle before recording starts
  // (i.e. while there are no track points yet) so the user can confirm a good
  // GPS lock and calibrate. Center once, then only move the dot/circle on later
  // fixes so panning to look around isn't fought.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (location && !points.length) {
      const ll: LatLngExpression = [location.lat, location.lng];
      const icon = L.divIcon({
        className: "",
        html: '<div style="width:14px;height:14px;border-radius:9999px;background:#60a5fa;border:2px solid #fff;box-shadow:0 0 0 2px rgba(96,165,250,.4)"></div>',
        iconSize: [14, 14], iconAnchor: [7, 7],
      });
      if (locDotRef.current) locDotRef.current.setLatLng(ll).setIcon(icon);
      else locDotRef.current = L.marker(ll, { icon, interactive: false }).addTo(map);

      if (location.acc != null) {
        if (locCircleRef.current) locCircleRef.current.setLatLng(ll).setRadius(location.acc);
        else locCircleRef.current = L.circle(ll, {
          radius: location.acc, color: "#60a5fa", weight: 1,
          fillColor: "#60a5fa", fillOpacity: 0.12, interactive: false,
        }).addTo(map);
      } else if (locCircleRef.current) {
        locCircleRef.current.remove();
        locCircleRef.current = null;
      }

      if (!locCenteredRef.current) {
        programmaticSetView(ll, Math.max(map.getZoom(), 16));
        locCenteredRef.current = true;
      }
    } else {
      if (locDotRef.current) { locDotRef.current.remove(); locDotRef.current = null; }
      if (locCircleRef.current) { locCircleRef.current.remove(); locCircleRef.current = null; }
      locCenteredRef.current = false;
    }
  }, [location, points.length, programmaticSetView]);

  return (
    // `isolation: isolate` keeps Leaflet's internal z-indexes (panes up to 800,
    // controls at 1000) contained to this box. Without it they leak to the root
    // stacking context and can paint over a higher-level overlay — e.g. an inline
    // History map bleeding through the full-screen RunDetailModal (z-50).
    <div className={className} style={{ position: "relative", isolation: "isolate", ...style }}>
      <div ref={elRef} style={{ position: "absolute", inset: 0 }} />
      {!MAP_KEY && (
        <div className="absolute bottom-1 left-1 right-1 z-[400] text-[10px] text-amber-300 bg-slate-900/80 rounded px-1.5 py-0.5 pointer-events-none">
          {t("tracker.map.noKey")}
        </div>
      )}
    </div>
  );
}
