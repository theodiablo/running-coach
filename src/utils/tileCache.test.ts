import { describe, it, expect } from "vitest";
import { tileCacheKey, selectTileEvictions, TILE_TTL_MS } from "./tileCache";

describe("tileCacheKey", () => {
  it("strips the API key so rotation doesn't orphan the cache", () => {
    expect(tileCacheKey("https://api.maptiler.com/maps/streets-v2/256/12/2048/1361.png?key=secret123"))
      .toBe("https://api.maptiler.com/maps/streets-v2/256/12/2048/1361.png");
  });

  it("keeps non-key params and survives non-URL input", () => {
    expect(tileCacheKey("https://x.test/t.png?style=a&key=k")).toBe("https://x.test/t.png?style=a");
    expect(tileCacheKey("not a url")).toBe("not a url");
  });
});

describe("selectTileEvictions", () => {
  const NOW = 1_800_000_000_000;
  const e = (key: string, ageMs: number) => ({ key, at: NOW - ageMs });

  it("evicts tiles past the TTL and keeps the rest", () => {
    const out = selectTileEvictions([e("old", TILE_TTL_MS + 1000), e("fresh", 1000)], NOW);
    expect(out).toEqual(["old"]);
  });

  it("evicts the oldest live tiles beyond the count cap", () => {
    const entries = [e("a", 3000), e("b", 1000), e("c", 2000)];
    expect(selectTileEvictions(entries, NOW, TILE_TTL_MS, 2)).toEqual(["a"]);
    expect(selectTileEvictions(entries, NOW, TILE_TTL_MS, 1).sort()).toEqual(["a", "c"]);
  });

  it("evicts nothing when everything is fresh and under the cap", () => {
    expect(selectTileEvictions([e("a", 1000), e("b", 2000)], NOW)).toEqual([]);
  });
});
