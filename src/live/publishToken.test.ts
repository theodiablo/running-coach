import { describe, it, expect, beforeEach, vi } from "vitest";
import { LIVE_PUBLISH_TOKEN_KEY } from "../constants";
import {
  PUBLISH_MAX_POINTS, isValidPointBatch, isValidPublishToken, mintPublishToken,
  readPublishToken, sanitizeStats, storePublishToken,
} from "./publishToken";

// The publish token is the ENTIRE authorization for the live-publish edge
// function — a WRITE capability. Same properties as the share token (genuinely
// unguessable, junk never reaches the network), plus the payload validators
// that keep an unauthenticated writing endpoint honest.

describe("mintPublishToken", () => {
  it("mints 128 bits as 22 base64url characters", () => {
    const token = mintPublishToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(isValidPublishToken(token)).toBe(true);
  });

  it("draws from the CSPRNG, not Math.random", () => {
    const spy = vi.spyOn(crypto, "getRandomValues");
    const rand = vi.spyOn(Math, "random");
    mintPublishToken();
    expect(spy).toHaveBeenCalledOnce();
    expect(rand).not.toHaveBeenCalled();
    spy.mockRestore();
    rand.mockRestore();
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintPublishToken()));
    expect(seen.size).toBe(200);
  });
});

describe("isValidPublishToken", () => {
  it("shares the share token's shape exactly", () => {
    expect(isValidPublishToken("a".repeat(21))).toBe(false);
    expect(isValidPublishToken("a".repeat(22))).toBe(true);
    expect(isValidPublishToken("a".repeat(64))).toBe(true);
    expect(isValidPublishToken("a".repeat(65))).toBe(false);
    expect(isValidPublishToken("a".repeat(21) + "/")).toBe(false);
    expect(isValidPublishToken(null)).toBe(false);
  });
});

describe("isValidPointBatch", () => {
  const pt = (t: number): unknown => [48.85, 2.35, t, 42];

  it("accepts a real batch, including gap markers and null altitude", () => {
    expect(isValidPointBatch([pt(1), null, [48.85, 2.35, 2, null], [48.85, 2.35, 3]])).toBe(true);
  });

  it("rejects empty, oversized and non-array batches", () => {
    expect(isValidPointBatch([])).toBe(false);
    expect(isValidPointBatch(Array.from({ length: PUBLISH_MAX_POINTS + 1 }, (_, i) => pt(i + 1)))).toBe(false);
    expect(isValidPointBatch("nope")).toBe(false);
    expect(isValidPointBatch(undefined)).toBe(false);
  });

  it("rejects out-of-range and non-finite coordinates", () => {
    expect(isValidPointBatch([[91, 0, 1, null]])).toBe(false);
    expect(isValidPointBatch([[0, -181, 1, null]])).toBe(false);
    expect(isValidPointBatch([[NaN, 0, 1, null]])).toBe(false);
    expect(isValidPointBatch([[0, Infinity, 1, null]])).toBe(false);
    expect(isValidPointBatch([[0, 0, 0, null]])).toBe(false); // t must be > 0
    expect(isValidPointBatch([[0, 0, 1, "high"]])).toBe(false);
    expect(isValidPointBatch([["48.85", "2.35", 1, null]])).toBe(false);
  });

  it("rejects malformed tuples", () => {
    expect(isValidPointBatch([[48.85, 2.35]])).toBe(false);
    expect(isValidPointBatch([[48.85, 2.35, 1, null, "extra"]])).toBe(false);
    expect(isValidPointBatch([{ lat: 48.85 }])).toBe(false);
  });
});

describe("sanitizeStats", () => {
  it("whitelists exactly the four watcher numbers", () => {
    expect(sanitizeStats({ km: 5.2, durationSec: 1800, avgPace: 346, curPace: 330, evil: "x".repeat(999) }))
      .toEqual({ km: 5.2, durationSec: 1800, avgPace: 346, curPace: 330 });
  });

  it("coerces junk to null so the RPC keeps the stored value", () => {
    // avgPace at km 0 is Infinity on the native side — must never be stored.
    expect(sanitizeStats({ km: NaN, durationSec: Infinity, avgPace: -1, curPace: "fast" }))
      .toEqual({ km: null, durationSec: null, avgPace: null, curPace: null });
    expect(sanitizeStats(null)).toEqual({ km: null, durationSec: null, avgPace: null, curPace: null });
    expect(sanitizeStats([1, 2, 3])).toEqual({ km: null, durationSec: null, avgPace: null, curPace: null });
  });
});

describe("token storage", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips and clears", () => {
    const token = mintPublishToken();
    storePublishToken(token);
    expect(readPublishToken()).toBe(token);
    storePublishToken(null);
    expect(readPublishToken()).toBeNull();
  });

  it("ignores junk left in storage", () => {
    localStorage.setItem(LIVE_PUBLISH_TOKEN_KEY, "not-a-token");
    expect(readPublishToken()).toBeNull();
  });
});
