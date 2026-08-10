// 30-day offline cache for raster map tiles, so the map still renders where
// the user has already been (their usual running routes) without a connection.
// IndexedDB, not the Cache API: IDB is reliably available in both Capacitor
// WebView schemes; Cache API availability varies by platform scheme.
//
// Every helper resolves harmlessly (null / no-op) when IndexedDB is missing or
// broken — tile caching must never be able to break the map itself.

export const TILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Size bound. Street tiles run ~15-40KB, so this caps the cache around 100MB —
// roomy enough for a month of routes at several zoom levels.
export const TILE_MAX_COUNT = 4000;

const DB_NAME = "rc_tile_cache";
const STORE = "tiles";

export type TileEntry = { blob: Blob; at: number };

// The tile URL carries the MapTiler API key as a query param; a key rotation
// must not orphan every cached tile, so the key is stripped from the cache key.
export function tileCacheKey(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("key");
    return u.toString();
  } catch {
    return url;
  }
}

// Everything past the TTL goes; if the survivors still exceed the cap, the
// oldest go too. Pure so the policy is testable without IndexedDB.
export function selectTileEvictions(
  entries: { key: string; at: number }[],
  now: number,
  ttlMs = TILE_TTL_MS,
  maxCount = TILE_MAX_COUNT,
): string[] {
  const expired: string[] = [];
  const live: { key: string; at: number }[] = [];
  for (const e of entries) {
    if (now - e.at > ttlMs) expired.push(e.key);
    else live.push(e);
  }
  const over = live.length - maxCount;
  if (over > 0) {
    const oldest = [...live].sort((a, b) => a.at - b.at).slice(0, over).map(e => e.key);
    return [...expired, ...oldest];
  }
  return expired;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") { resolve(null); return; }
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

export async function getTile(key: string): Promise<TileEntry | null> {
  const idb = await openDb();
  if (!idb) return null;
  return new Promise((resolve) => {
    try {
      const req = idb.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => {
        const v = req.result as TileEntry | undefined;
        resolve(v && v.blob instanceof Blob && typeof v.at === "number" ? v : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function putTile(key: string, blob: Blob): Promise<void> {
  const idb = await openDb();
  if (!idb) return;
  return new Promise((resolve) => {
    try {
      const tx = idb.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ blob, at: Date.now() } satisfies TileEntry, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

// Applies the eviction policy above. Fire-and-forget, once per app session
// (cachedTileLayer calls it on first layer creation).
let pruned = false;
export async function pruneTileCache(): Promise<void> {
  if (pruned) return;
  pruned = true;
  const idb = await openDb();
  if (!idb) return;
  const entries = await new Promise<{ key: string; at: number }[]>((resolve) => {
    const acc: { key: string; at: number }[] = [];
    try {
      const req = idb.transaction(STORE, "readonly").objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(acc); return; }
        const v = cur.value as TileEntry;
        acc.push({ key: String(cur.key), at: typeof v?.at === "number" ? v.at : 0 });
        cur.continue();
      };
      req.onerror = () => resolve(acc);
    } catch {
      resolve(acc);
    }
  });
  const evict = selectTileEvictions(entries, Date.now());
  if (!evict.length) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = idb.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      evict.forEach(k => store.delete(k));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
