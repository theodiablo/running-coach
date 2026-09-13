import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WEB_APP_ORIGIN } from "../constants";

const native = vi.hoisted(() => ({ isNative: false }));
vi.mock("../native", () => native);

import {
  SHARE_TOKEN_BYTES, fetchLiveWatch, isValidShareToken, mintShareToken,
  parseWatchToken, shareLinkState, watchUrl,
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

describe("watchUrl origin", () => {
  const token = "a".repeat(22);
  afterEach(() => { native.isNative = false; });

  it("uses the current origin on the web", () => {
    expect(watchUrl(token)).toBe(`${window.location.origin}/watch/${token}`);
  });

  it("names the web app on native, never the shell's local origin", () => {
    // The shells serve the bundle from https://localhost (Android) /
    // capacitor://localhost (iOS), so window.location.origin there is an address
    // only that phone can open — a link nobody the runner sent it to can follow.
    native.isNative = true;
    expect(watchUrl(token)).toBe(`${WEB_APP_ORIGIN}/watch/${token}`);
    expect(watchUrl(token)).not.toContain("localhost");
  });
});

describe("shareLinkState", () => {
  const TOKEN = "a".repeat(22);

  it("offers to create a link when the account has none", () => {
    expect(shareLinkState({ token: null, sharing: true })).toEqual({ kind: "none" });
    // Sharing being off changes nothing here: the link is the account's, and
    // claiming one outside a run is legitimate.
    expect(shareLinkState({ token: null, sharing: false })).toEqual({ kind: "none" });
  });

  it("reports a claim in flight, whatever else is true", () => {
    expect(shareLinkState({ token: TOKEN, sharing: true, busy: true, confirmed: true }))
      .toEqual({ kind: "busy" });
  });

  it("shows the link as inactive when this run is not being shared", () => {
    // The state the first draft of this feature had no way to render: the link
    // exists, so it must stay visible and replaceable, but showing it as live
    // would tell the runner people can see a run that is not being published.
    const off = shareLinkState({ token: TOKEN, sharing: false, confirmed: true });
    expect(off).toMatchObject({ kind: "link", active: false, sendable: true });
    const on = shareLinkState({ token: TOKEN, sharing: true, confirmed: true });
    expect(on).toMatchObject({ kind: "link", active: true, url: watchUrl(TOKEN) });
  });

  it("refuses to offer an unconfirmed token for sending", () => {
    // A link replaced on another device is still in this one's cache. Sending
    // it would hand someone an address that resolves to nothing, for good.
    expect(shareLinkState({ token: TOKEN, sharing: true, confirmed: false }))
      .toMatchObject({ kind: "link", sendable: false });
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
