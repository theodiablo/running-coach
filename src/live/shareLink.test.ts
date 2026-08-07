import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LIVE_SHARE_TOKEN_KEY } from "../constants";
import {
  SHARE_TOKEN_BYTES, fetchLiveWatch, isValidShareToken, mintShareToken,
  parseWatchToken, readShareToken, storeShareToken, watchUrl,
} from "./shareLink";

// The share token is the ENTIRE authorization for a public /watch/:token page,
// so these tests are about the two properties that makes true: it is genuinely
// unguessable, and a URL that isn't one never reaches the network.

describe("mintShareToken", () => {
  it("mints 128 bits as 22 base64url characters", () => {
    const token = mintShareToken();
    expect(SHARE_TOKEN_BYTES).toBe(16);
    expect(token).toHaveLength(22);
    // URL-path safe: no +, / or = to be mangled or stripped in transit.
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(isValidShareToken(token)).toBe(true);
  });

  it("draws from the CSPRNG, not Math.random", () => {
    // A predictable token would leave the design looking identical while being
    // worthless — the entropy IS the anti-crawling story.
    const spy = vi.spyOn(crypto, "getRandomValues");
    const rand = vi.spyOn(Math, "random");
    mintShareToken();
    expect(spy).toHaveBeenCalledOnce();
    expect(rand).not.toHaveBeenCalled();
    spy.mockRestore();
    rand.mockRestore();
  });

});

describe("isValidShareToken", () => {
  it("rejects anything short enough to be worth guessing", () => {
    expect(isValidShareToken("abc")).toBe(false);
    expect(isValidShareToken("a".repeat(21))).toBe(false);
    expect(isValidShareToken("a".repeat(22))).toBe(true);
  });

  it("rejects characters the URL or the CHECK constraint would not survive", () => {
    expect(isValidShareToken("a".repeat(21) + "/")).toBe(false);
    expect(isValidShareToken("a".repeat(21) + "=")).toBe(false);
    expect(isValidShareToken("a".repeat(21) + ".")).toBe(false);
    expect(isValidShareToken("a".repeat(65))).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isValidShareToken(null)).toBe(false);
    expect(isValidShareToken(undefined)).toBe(false);
    expect(isValidShareToken(12345678901234567890123)).toBe(false);
  });
});

describe("parseWatchToken", () => {
  const token = "a".repeat(22);

  it("reads the token out of a watch path", () => {
    expect(parseWatchToken(`/watch/${token}`)).toBe(token);
  });

  it("is not a watch path otherwise", () => {
    expect(parseWatchToken("/")).toBeNull();
    expect(parseWatchToken("/watch")).toBeNull();
    expect(parseWatchToken("/watch/")).toBeNull();
    expect(parseWatchToken("/nope/" + token)).toBeNull();
  });

  it("refuses a malformed token instead of passing it on", () => {
    // A junk path must never reach the network: a crawler walking short strings
    // should cost us a regex, not a request.
    expect(parseWatchToken("/watch/short")).toBeNull();
    expect(parseWatchToken(`/watch/${token}/extra`)).toBeNull();
    expect(parseWatchToken(`/watch/${token}?x=1`)).toBeNull();
  });

  it("builds the URL it parses back", () => {
    expect(parseWatchToken(new URL(watchUrl(token, "https://example.test")).pathname)).toBe(token);
  });
});

describe("token storage", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips and clears", () => {
    const token = mintShareToken();
    storeShareToken(token);
    expect(readShareToken()).toBe(token);
    storeShareToken(null);
    expect(readShareToken()).toBeNull();
  });

  it("ignores junk left in storage", () => {
    localStorage.setItem(LIVE_SHARE_TOKEN_KEY, "not-a-token");
    expect(readShareToken()).toBeNull();
  });
});

describe("fetchLiveWatch", () => {
  const token = "a".repeat(22);
  const ok = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) => ({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: { get: (k: string) => init.headers?.[k] ?? null },
    json: async () => body,
  });

  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("returns the run when one is live", async () => {
    const run = { status: "live", started_at: "x", updated_at: "y", points: [], stats: {} };
    vi.mocked(fetch).mockResolvedValue(ok({ live: true, run }) as unknown as Response);
    await expect(fetchLiveWatch(token)).resolves.toEqual({ kind: "live", run });
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain(`t=${token}`);
  });

  it("maps the uniform not-live answer to one result", async () => {
    // A bad token, a run that hasn't started and a swept row are the SAME
    // response by design — the page must not be able to tell them apart either.
    vi.mocked(fetch).mockResolvedValue(ok({ live: false }) as unknown as Response);
    await expect(fetchLiveWatch(token)).resolves.toEqual({ kind: "none" });
  });

  it("reports a transport failure as an error, never as 'not live'", async () => {
    // The distinction is the whole point: a dropped connection rendered as
    // "nothing here" would tell a viewer the run ended when it hasn't.
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    await expect(fetchLiveWatch(token)).resolves.toEqual({ kind: "error" });

    vi.mocked(fetch).mockResolvedValue(ok({}, { status: 500 }) as unknown as Response);
    await expect(fetchLiveWatch(token)).resolves.toEqual({ kind: "error" });
  });

  it("passes a rate limit's Retry-After back to the caller", async () => {
    vi.mocked(fetch).mockResolvedValue(
      ok({}, { status: 429, headers: { "Retry-After": "60" } }) as unknown as Response);
    await expect(fetchLiveWatch(token)).resolves.toEqual({ kind: "error", retryAfterMs: 60000 });
  });

  it("survives a body that isn't the shape we expect", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => { throw new Error("not json"); },
    } as unknown as Response);
    await expect(fetchLiveWatch(token)).resolves.toEqual({ kind: "none" });
  });
});
