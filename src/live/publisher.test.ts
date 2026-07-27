import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LIVE_RUN_KEY } from "../constants";

// The publisher's whole job is deciding WHEN to hit the network: a run publishes
// off GPS fixes (never a timer), at most every 30s, with status transitions
// jumping the queue. These tests drive that decision directly and assert against
// a mocked Supabase client, so no network or real clock is involved.

type UpsertResult = Promise<{ error: { code?: string } | null }>;

const h = vi.hoisted(() => {
  const upsert = vi.fn<(row: Record<string, unknown>, opts?: unknown) => UpsertResult>(async () => ({ error: null }));
  const eq = vi.fn(async () => ({ error: null }));
  const del = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ upsert, delete: del }));
  let uid: string | null = "u1";
  return { upsert, eq, del, from, currentUserId: () => uid, setUid: (v: string | null) => { uid = v; } };
});

vi.mock("../supabase", () => ({ supabase: { from: h.from } }));
vi.mock("../db", () => ({ currentUserId: h.currentUserId }));

import {
  LIVE_PUBLISH_INTERVAL_MS, canPublishNow, clearStaleLiveRun, endLiveRun,
  publishLiveRun, resetLivePublisher, shouldPublish,
} from "./publisher";

const START = 1_700_000_000_000;
const args = (status: "live" | "paused" | "ended" = "live") => ({
  status,
  points: [[1, 2, START, null] as const],
  stats: { km: 1, durationSec: 300, avgPace: 300, curPace: 300 },
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  h.setUid("u1");
  h.upsert.mockResolvedValue({ error: null });
  resetLivePublisher();
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => vi.useRealTimers());

describe("shouldPublish", () => {
  const base = { now: START, lastAt: START, status: "live" as const, prevStatus: "live" as const, busy: false };

  it("throttles repeat publishes to the interval", () => {
    expect(shouldPublish({ ...base, now: START + LIVE_PUBLISH_INTERVAL_MS - 1 })).toBe(false);
    expect(shouldPublish({ ...base, now: START + LIVE_PUBLISH_INTERVAL_MS })).toBe(true);
  });

  it("lets a status change jump the throttle", () => {
    // A pause can't be re-triggered by a later fix (paused runs drop them), so
    // waiting out the interval would leave the watcher on stale status.
    expect(shouldPublish({ ...base, status: "paused", now: START + 1 })).toBe(true);
  });

  it("publishes the first write immediately", () => {
    expect(shouldPublish({ ...base, lastAt: 0, prevStatus: null, now: START })).toBe(true);
  });

  it("never overlaps an upload in flight", () => {
    expect(shouldPublish({ ...base, busy: true, now: START + LIVE_PUBLISH_INTERVAL_MS * 10 })).toBe(false);
  });
});

describe("publishLiveRun", () => {
  it("writes once per interval however often it is called", async () => {
    await publishLiveRun(args());
    await publishLiveRun(args());
    vi.setSystemTime(START + LIVE_PUBLISH_INTERVAL_MS - 1);
    await publishLiveRun(args());
    expect(h.upsert).toHaveBeenCalledTimes(1);

    vi.setSystemTime(START + LIVE_PUBLISH_INTERVAL_MS);
    await publishLiveRun(args());
    expect(h.upsert).toHaveBeenCalledTimes(2);
  });

  it("stamps started_at only on the first write of a run", async () => {
    await publishLiveRun({ ...args(), startedAt: START });
    expect(h.upsert.mock.calls[0][0]).toMatchObject({ started_at: new Date(START).toISOString() });

    vi.setSystemTime(START + LIVE_PUBLISH_INTERVAL_MS);
    await publishLiveRun({ ...args(), startedAt: START });
    expect(h.upsert.mock.calls[1][0]).not.toHaveProperty("started_at");
  });

  it("stops retrying after a policy rejection (a lapsed or absent entitlement)", async () => {
    h.upsert.mockResolvedValue({ error: { code: "42501" } });
    await publishLiveRun(args());
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(canPublishNow("live")).toBe(false);

    vi.setSystemTime(START + LIVE_PUBLISH_INTERVAL_MS * 5);
    await publishLiveRun(args());
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying after an ordinary failure, on the next interval", async () => {
    h.upsert.mockResolvedValue({ error: { code: "500" } });
    await publishLiveRun(args());
    vi.setSystemTime(START + LIVE_PUBLISH_INTERVAL_MS);
    await publishLiveRun(args());
    expect(h.upsert).toHaveBeenCalledTimes(2);
  });

  it("swallows a thrown transport error so recording is never affected", async () => {
    h.upsert.mockRejectedValue(new Error("offline"));
    await expect(publishLiveRun(args())).resolves.toBeUndefined();
  });

  it("does nothing when signed out", async () => {
    h.setUid(null);
    await publishLiveRun(args());
    expect(h.upsert).not.toHaveBeenCalled();
  });
});

describe("endLiveRun", () => {
  it("deletes the row and re-arms for the next run", async () => {
    await publishLiveRun(args());
    await endLiveRun();
    expect(h.eq).toHaveBeenCalledWith("user_id", "u1");
    // Re-armed: the next run publishes immediately rather than waiting out the
    // previous run's throttle window.
    expect(canPublishNow("live")).toBe(true);
  });
});

describe("clearStaleLiveRun", () => {
  it("deletes an orphan row when no run is recoverable", async () => {
    await clearStaleLiveRun();
    expect(h.eq).toHaveBeenCalledWith("user_id", "u1");
  });

  it("leaves the row alone while a recoverable run buffer exists", async () => {
    // That run can still be resumed, and a watcher may be following it.
    localStorage.setItem(LIVE_RUN_KEY, JSON.stringify({ points: [[1, 2, START, null]] }));
    await clearStaleLiveRun();
    expect(h.del).not.toHaveBeenCalled();
  });

  it("ignores a malformed buffer rather than skipping the sweep", async () => {
    localStorage.setItem(LIVE_RUN_KEY, "{not json");
    await clearStaleLiveRun();
    expect(h.eq).toHaveBeenCalledWith("user_id", "u1");
  });
});
