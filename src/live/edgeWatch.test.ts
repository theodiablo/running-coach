// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://run.camboulive.solutions/watch/aaaaaaaaaaaaaaaaaaaaaa" }
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WEB_APP_ORIGIN } from "../constants";
import { fetchLiveWatch, watchViewerId } from "./shareLink";

const json = (body: unknown) => ({
  ok: true, status: 200, headers: { get: (k: string) => (k === "Content-Type" ? "application/json" : null) },
  json: async () => body,
}) as unknown as Response;
const live = (started_at: string) => json({ live: true, run: { status: "live", started_at, updated_at: "u", points: [], stats: {} } });

describe("fetchLiveWatch on the web origin (edge cache)", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());
  const urls = () => vi.mocked(fetch).mock.calls.map(([u]) => String(u));

  it("runs on the origin CloudFront fronts", () => {
    expect(window.location.origin).toBe(WEB_APP_ORIGIN);
  });

  it("polls direct with the viewer id until a run is seen live, then through the cache without it", async () => {
    const token = "a".repeat(22);
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ live: false }))
      .mockResolvedValueOnce(live("s1"))
      .mockResolvedValueOnce(live("s1"));
    for (let i = 0; i < 3; i++) await fetchLiveWatch(token);
    const [beforeRun, firstLive, cached] = urls();
    expect(beforeRun).toContain(`v=${watchViewerId()}`);
    expect(firstLive).toContain(`v=${watchViewerId()}`);
    // Same-origin, no viewer id and no apikey headers: one shared cache entry per run.
    expect(cached).toBe(`/live-watch/${token}`);
    expect(vi.mocked(fetch).mock.calls[2][1]).not.toHaveProperty("headers");
  });

  it("goes direct once more when the cache shows a new broadcast, so its view is counted", async () => {
    const token = "b".repeat(22);
    vi.mocked(fetch)
      .mockResolvedValueOnce(live("s1"))
      .mockResolvedValueOnce(live("s2"))
      .mockResolvedValueOnce(live("s2"))
      .mockResolvedValueOnce(live("s2"));
    for (let i = 0; i < 4; i++) await fetchLiveWatch(token);
    const [, sawNew, recount, cachedAgain] = urls();
    expect(sawNew).toBe(`/live-watch/${token}`);
    expect(recount).toContain(`v=${watchViewerId()}`);
    expect(cachedAgain).toBe(`/live-watch/${token}`);
  });

  it("falls back to a direct read when the edge path answers with the SPA page", async () => {
    // A bundle deployed before the CloudFront behavior exists gets index.html for /live-watch/*.
    const token = "c".repeat(22);
    const html = { ok: true, status: 200, headers: { get: () => "text/html" }, json: async () => ({}) } as unknown as Response;
    vi.mocked(fetch)
      .mockResolvedValueOnce(live("s1"))
      .mockResolvedValueOnce(html)
      .mockResolvedValueOnce(live("s1"));
    await fetchLiveWatch(token);
    await expect(fetchLiveWatch(token)).resolves.toMatchObject({ kind: "live" });
    const [, edge, direct] = urls();
    expect(edge).toBe(`/live-watch/${token}`);
    expect(direct).toContain(`t=${token}`);
  });

  it("confirms a cached 'not live' with a direct read before believing it", async () => {
    const token = "d".repeat(22);
    vi.mocked(fetch)
      .mockResolvedValueOnce(live("s1"))
      .mockResolvedValueOnce(json({ live: false }))
      .mockResolvedValueOnce(live("s1"));
    await fetchLiveWatch(token);
    await expect(fetchLiveWatch(token)).resolves.toMatchObject({ kind: "live" });
    expect(urls()[2]).toContain(`t=${token}`);
  });
});
