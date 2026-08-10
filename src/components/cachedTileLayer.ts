import L, { type Layer, type Map } from "leaflet";
import { getTile, putTile, pruneTileCache, tileCacheKey, TILE_TTL_MS, type TileEntry } from "../utils/tileCache";

// Drop-in replacement for L.tileLayer that serves tiles cache-first from
// IndexedDB (utils/tileCache): a tile cached within the TTL never touches the
// network, a fetched tile is stored for next time, and when the network is
// unreachable a stale cached tile still renders — which is what keeps the map
// usable offline anywhere the user has already been. On any failure it falls
// back to a plain <img src=url> load (the pre-cache behavior), so caching can
// only ever add tiles, never lose them.

type DoneFn = (err: Error | null, tile: HTMLElement) => void;

// Picks the tile's source. Exported for tests; `fetchTile` is the network.
export async function resolveTileSrc(
  url: string,
  fetchTile: (u: string) => Promise<Blob>,
  now: number,
): Promise<{ src: string; revoke: boolean }> {
  const key = tileCacheKey(url);
  let cached: TileEntry | null = null;
  try { cached = await getTile(key); } catch { cached = null; }
  if (cached && now - cached.at <= TILE_TTL_MS) {
    return { src: URL.createObjectURL(cached.blob), revoke: true };
  }
  try {
    const blob = await fetchTile(url);
    putTile(key, blob).catch(() => {});
    return { src: URL.createObjectURL(blob), revoke: true };
  } catch {
    // Offline (or a blocked fetch): a stale tile beats a blank one; with no
    // cache at all, let the browser try the plain image load.
    if (cached) return { src: URL.createObjectURL(cached.blob), revoke: true };
    return { src: url, revoke: false };
  }
}

async function fetchTileBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tile fetch ${res.status}`);
  return res.blob();
}

function loadTile(tile: HTMLImageElement, url: string, done: DoneFn) {
  resolveTileSrc(url, fetchTileBlob, Date.now()).then(({ src, revoke }) => {
    tile.onload = () => { if (revoke) URL.revokeObjectURL(src); done(null, tile); };
    tile.onerror = () => { if (revoke) URL.revokeObjectURL(src); done(new Error("tile load failed"), tile); };
    tile.src = src;
  });
}

const CachedTileLayer = L.TileLayer.extend({
  createTile(this: { getTileUrl(coords: unknown): string }, coords: unknown, done: DoneFn) {
    const tile = document.createElement("img");
    tile.alt = "";
    tile.setAttribute("role", "presentation");
    loadTile(tile, this.getTileUrl(coords), done);
    return tile;
  },
});

export function cachedTileLayer(url: string, options?: Record<string, unknown>): Layer & { addTo: (map: Map) => Layer } {
  pruneTileCache(); // fire-and-forget; self-limits to once per app session
  return new CachedTileLayer(url, options);
}
