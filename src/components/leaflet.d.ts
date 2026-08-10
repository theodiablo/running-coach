declare module "leaflet" {
  export type LatLngExpression = readonly (number | null)[];
  export type LatLngTuple = [number, number];
  export type LatLng = { lat: number; lng: number };
  export type LeafletEvent = { latlng: LatLng };
  export type DivIcon = unknown;
  export type Control = unknown;
  export type Layer = { remove: () => void };
  export type Marker = Layer & {
    setLatLng: (latlng: LatLngExpression) => Marker;
    setIcon: (icon: DivIcon) => Marker;
    getLatLng: () => LatLng;
    on: (event: string, cb: () => void) => Marker;
  };
  export type Circle = Layer & {
    setLatLng: (latlng: LatLngExpression) => Circle;
    setRadius: (radius: number) => Circle;
  };
  export type Polyline = Layer & {
    on: (event: string, cb: (e: LeafletEvent) => void) => Polyline;
    bindTooltip: (content: string, options?: Record<string, unknown>) => Polyline;
    // Mutates the existing SVG path — how the live track grows without a rebuild.
    setLatLngs: (points: LatLngExpression[]) => Polyline;
  };
  export type ToggleHandler = { enable: () => void; disable: () => void };
  export type Map = {
    setView: (latlng: LatLngExpression, zoom: number, options?: { animate?: boolean }) => Map;
    getZoom: () => number;
    fitBounds: (bounds: unknown, options?: { animate?: boolean }) => Map;
    addControl: (control: Control) => Map;
    removeControl: (control: Control) => Map;
    createPane: (name: string) => HTMLElement;
    getPane: (name: string) => HTMLElement | undefined;
    remove: () => void;
    on: (event: string, cb: (e: LeafletEvent) => void) => Map;
    off: (event: string, cb?: (e: LeafletEvent) => void) => Map;
    dragging?: ToggleHandler;
    scrollWheelZoom?: ToggleHandler;
    doubleClickZoom?: ToggleHandler;
    boxZoom?: ToggleHandler;
    keyboard?: ToggleHandler;
    touchZoom?: ToggleHandler;
    tap?: ToggleHandler;
  };
  type Addable<T> = T & { addTo: (map: Map) => T };
  // Leaflet's class system: extend() returns a constructor whose prototype
  // includes getTileUrl — enough surface for cachedTileLayer's createTile
  // override, plus the tile lifecycle events its blob-URL cleanup listens to.
  export type TileEventHandler = (e: { tile?: HTMLElement }) => void;
  type TileLayerInstance = Addable<Layer> & { on: (event: string, cb: TileEventHandler) => TileLayerInstance };
  type TileLayerClass = {
    extend: (proto: Record<string, unknown>) => new (url: string, options?: Record<string, unknown>) => TileLayerInstance;
  };
  type LeafletModule = {
    map: (el: HTMLElement, options?: Record<string, unknown>) => Map;
    tileLayer: (url: string, options?: Record<string, unknown>) => Addable<Layer>;
    TileLayer: TileLayerClass;
    control: { zoom: () => Control };
    polyline: (points: LatLngExpression[], options?: Record<string, unknown>) => Addable<Polyline>;
    marker: (latlng: LatLngExpression, options?: Record<string, unknown>) => Addable<Marker>;
    circle: (latlng: LatLngExpression, options?: Record<string, unknown>) => Addable<Circle>;
    divIcon: (options?: Record<string, unknown>) => DivIcon;
    latLngBounds: (points: LatLngExpression[]) => { pad: (amount: number) => unknown };
  };
  const L: LeafletModule;
  export default L;
}
