import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The sourcing policy behind the offline map: fresh cache never touches the
// network, fetched tiles are stored for next time, a stale cached tile still
// renders when the network is gone, and with no cache at all the plain image
// URL is the fallback (the pre-cache behavior).

const h = vi.hoisted(() => ({
  getTile: vi.fn(async (): Promise<{ blob: Blob; at: number } | null> => null),
  putTile: vi.fn(async () => {}),
}));

vi.mock("../utils/tileCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/tileCache")>()),
  getTile: h.getTile,
  putTile: h.putTile,
}));

import { resolveTileSrc } from "./cachedTileLayer";
import { TILE_TTL_MS } from "../utils/tileCache";

const NOW = 1_800_000_000_000;
const URL_WITH_KEY = "https://api.maptiler.com/maps/streets-v2/256/12/1/2.png?key=k";
const CACHE_KEY = "https://api.maptiler.com/maps/streets-v2/256/12/1/2.png";
const blob = new Blob(["tile"], { type: "image/png" });

beforeEach(() => {
  h.getTile.mockReset().mockResolvedValue(null);
  h.putTile.mockReset().mockResolvedValue(undefined);
  // jsdom's URL lacks the object-URL statics; patch just those so `new URL()`
  // (which tileCacheKey needs) keeps working.
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

describe("resolveTileSrc", () => {
  it("serves a fresh cached tile without fetching", async () => {
    h.getTile.mockResolvedValue({ blob, at: NOW - 1000 });
    const fetchTile = vi.fn();
    const out = await resolveTileSrc(URL_WITH_KEY, fetchTile, NOW);
    expect(out).toEqual({ src: "blob:mock", revoke: true });
    expect(h.getTile).toHaveBeenCalledWith(CACHE_KEY);
    expect(fetchTile).not.toHaveBeenCalled();
  });

  it("fetches a stale tile and stores the fresh copy under the keyless URL", async () => {
    h.getTile.mockResolvedValue({ blob, at: NOW - TILE_TTL_MS - 1000 });
    const fetchTile = vi.fn(async () => blob);
    const out = await resolveTileSrc(URL_WITH_KEY, fetchTile, NOW);
    expect(out.revoke).toBe(true);
    expect(fetchTile).toHaveBeenCalledWith(URL_WITH_KEY); // real URL keeps the API key
    expect(h.putTile).toHaveBeenCalledWith(CACHE_KEY, blob);
  });

  it("falls back to the stale cached tile when the fetch fails (offline)", async () => {
    h.getTile.mockResolvedValue({ blob, at: NOW - TILE_TTL_MS - 1000 });
    const out = await resolveTileSrc(URL_WITH_KEY, async () => { throw new Error("offline"); }, NOW);
    expect(out).toEqual({ src: "blob:mock", revoke: true });
  });

  it("falls back to the plain image URL when there is no cache and no network", async () => {
    const out = await resolveTileSrc(URL_WITH_KEY, async () => { throw new Error("offline"); }, NOW);
    expect(out).toEqual({ src: URL_WITH_KEY, revoke: false });
    expect(h.putTile).not.toHaveBeenCalled();
  });

  it("treats a cache read error as a miss", async () => {
    h.getTile.mockRejectedValue(new Error("idb broken"));
    const fetchTile = vi.fn(async () => blob);
    const out = await resolveTileSrc(URL_WITH_KEY, fetchTile, NOW);
    expect(out.revoke).toBe(true);
    expect(fetchTile).toHaveBeenCalled();
  });
});
