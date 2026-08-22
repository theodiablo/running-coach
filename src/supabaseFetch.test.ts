import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "./supabase";

// Guards the retry of PostgREST's 401 `PGRST303` ("JWT issued at future").
// Supabase's auth node stamps `iat`; a PostgREST node whose clock is a few
// seconds behind rejects the token it just issued. It only ever hits the
// requests fired in the first seconds after a sign-in, which on the Android
// registration deep link meant the app_state boot read 401'd and the user got
// the StoreLoadError screen on a brand-new account.

const skew = () =>
  new Response(JSON.stringify({ code: "PGRST303", message: "JWT issued at future" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
const ok = (body = '{"ok":true}') =>
  new Response(body, { status: 200, headers: { "content-type": "application/json" } });

// Drains the retry sleeps without waiting on them in real time.
async function settle(pending: Promise<Response>) {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(10_000);
  return pending;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchWithTimeout", () => {
  it("retries a PGRST303 rejection until the clocks agree", async () => {
    fetchMock.mockResolvedValueOnce(skew()).mockResolvedValueOnce(ok());

    const res = await settle(fetchWithTimeout("https://example.test/rest/v1/app_state"));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a body the caller can still read", async () => {
    fetchMock.mockResolvedValueOnce(skew()).mockResolvedValueOnce(ok('{"data":42}'));

    const res = await settle(fetchWithTimeout("https://example.test/rest/v1/app_state"));

    // The rejection check reads a clone, so the surviving response is intact.
    await expect(res.json()).resolves.toEqual({ data: 42 });
  });

  it("does not retry a 401 that is a real auth failure", async () => {
    const denied = new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
    fetchMock.mockResolvedValue(denied);

    const res = await settle(fetchWithTimeout("https://example.test/auth/v1/token"));

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 401 with no JSON body", async () => {
    fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    await settle(fetchWithTimeout("https://example.test/rest/v1/app_state"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves a successful request alone", async () => {
    fetchMock.mockResolvedValue(ok());

    await settle(fetchWithTimeout("https://example.test/rest/v1/app_state"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a write too — PostgREST rejects it before the database sees it", async () => {
    fetchMock.mockResolvedValueOnce(skew()).mockResolvedValueOnce(ok());

    const res = await settle(fetchWithTimeout("https://example.test/rest/v1/app_state", {
      method: "POST",
      body: '{"user_id":"u1"}',
    }));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up rather than retrying forever", async () => {
    fetchMock.mockResolvedValue(skew());

    const res = await settle(fetchWithTimeout("https://example.test/rest/v1/app_state"));

    expect(res.status).toBe(401);
    // One attempt plus the four backoff delays.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("stops retrying once the caller's signal aborts", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(skew());
    });

    await settle(fetchWithTimeout("https://example.test/rest/v1/app_state", {
      signal: controller.signal,
    }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
