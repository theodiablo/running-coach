import L, { type Layer, type Map, type TileEventHandler } from "leaflet";
import { getTile, putTile, pruneTileCache, tileCacheKey, TILE_TTL_MS, type TileEntry } from "../utils/tileCache";

// Drop-in replacement for L.tileLayer that serves tiles cache-first from
// IndexedDB (utils/tileCache): a tile cached within the TTL never touches the
// network, a fetched tile is stored for next time, and when the network is
// unreachable a stale cached tile still renders — which is what keeps the map
// usable offline anywhere the user has already been. On any failure it falls
// back to a plain <img src=url> load (the pre-cache behavior), so caching can
// only ever add tiles, never lose them.

type DoneFn = (err: Error | null, tile: HTMLElement) => void;

// Blob object URLs per tile element, so they can be revoked no matter how the
// tile's life ends (loaded, errored, or aborted by a zoom).
const blobUrls = new WeakMap<HTMLElement, string>();
function revokeTileUrl(tile?: HTMLElement) {
  if (!tile) return;
  const url = blobUrls.get(tile);
  if (url) {
    URL.revokeObjectURL(url);
    blobUrls.delete(tile);
  }
}

// Picks the tile's source. Exported for tests; `fetchTile` is the network.
export async function resolveTileSrc(
  url: string,
  fetchTile: (u: string) => Promise<Blob>,
  now: number,
): Promise<{ src: string; revoke: boolean }> {
  const key = tileCacheKey(url);
  let cached: TileEntry | null = null;
  try { cached = await getTile(key); } catch { cached = null; }
  try {
    if (cached && now - cached.at <= TILE_TTL_MS) {
      return { src: URL.createObjectURL(cached.blob), revoke: true };
    }
    const blob = await fetchTile(url);
    putTile(key, blob).catch(() => {});
    return { src: URL.createObjectURL(blob), revoke: true };
  } catch {
    // Offline (or a blocked fetch): a stale tile beats a blank one; with no
    // cache at all, let the browser try the plain image load.
    if (cached) {
      try { return { src: URL.createObjectURL(cached.blob), revoke: true }; } catch { /* fall through */ }
    }
    return { src: url, revoke: false };
  }
}

// Exported for tests. The content-type guard matters on captive portals: a
// login page answers 200 with HTML, and caching that for 30 days would leave
// the map broken long after connectivity returns.
export async function fetchTileBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  const type = res.headers.get("content-type") || "";
  if (!res.ok || !type.startsWith("image/")) throw new Error(`tile fetch ${res.status} ${type}`);
  return res.blob();
}

function loadTile(tile: HTMLImageElement, url: string) {
  resolveTileSrc(url, fetchTileBlob, Date.now())
    .then(({ src, revoke }) => {
      if (revoke) blobUrls.set(tile, src);
      tile.src = src;
    })
    // resolveTileSrc is defensive, but an unexpected rejection must neither
    // strand the tile nor reach ErrorBoundary's unhandledrejection overlay.
    .catch(() => { tile.src = url; });
}

const CachedTileLayer = L.TileLayer.extend({
  createTile(this: { getTileUrl(coords: unknown): string }, coords: unknown, done: DoneFn) {
    const tile = document.createElement("img");
    tile.alt = "";
    tile.setAttribute("role", "presentation");
    // addEventListener, NOT tile.onload/onerror: Leaflet's _abortLoading
    // replaces those properties with a no-op on zoom, which would silently
    // drop both done() and the object-URL revocation.
    tile.addEventListener("load", () => { revokeTileUrl(tile); done(null, tile); }, { once: true });
    tile.addEventListener("error", () => { revokeTileUrl(tile); done(new Error("tile load failed"), tile); }, { once: true });
    loadTile(tile, this.getTileUrl(coords));
    return tile;
  },
});

export function cachedTileLayer(url: string, options?: Record<string, unknown>): Layer & { addTo: (map: Map) => Layer } {
  pruneTileCache().catch(() => {}); // fire-and-forget; self-limits to once per app session
  const layer = new CachedTileLayer(url, options);
  // A tile aborted mid-flight or pruned off-screen never fires load/error, so
  // its blob URL is revoked from the layer events instead.
  const revoke: TileEventHandler = e => revokeTileUrl(e.tile);
  layer.on("tileabort", revoke);
  layer.on("tileunload", revoke);
  return layer;
}
