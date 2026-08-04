import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LIVE_PUBLISHED_KEY, LIVE_RUN_KEY, LIVE_SHARE_TOKEN_KEY, RESUME_MAX_AGE_MS } from "../constants";

// The publisher's job is deciding WHEN to hit the network and WITH WHICH verb: a
// run publishes off GPS fixes (never a timer), at most every 30s, with status
// transitions jumping the queue — and it opens a broadcast with an INSERT but
// continues it with an UPDATE, because only the former is premium-gated. These
// tests drive those decisions directly against a mocked Supabase client, so no
// network and no real clock is involved.

const h = vi.hoisted(() => {
  // `message` matters as well as `code`: two different constraints both surface
  // as 23505 here (the primary key, and the share_token unique index), and only
  // the message tells them apart.
  type DbError = { code?: string; message?: string };
  const insert = vi.fn<(row: Record<string, unknown>) => Promise<{ error: DbError | null }>>(
    async () => ({ error: null }));
  const delEq = vi.fn<(col: string, val: string) => Promise<{ error: DbError | null }>>(
    async () => ({ error: null }));
  const del = vi.fn(() => ({ eq: delEq }));
  const updateSelect = vi.fn<() => Promise<{ data: unknown[] | null; error: DbError | null }>>(
    async () => ({ data: [{ user_id: "u1" }], error: null }));
  const updateEq = vi.fn(() => ({ select: updateSelect }));
  const update = vi.fn<(row: Record<string, unknown>) => { eq: typeof updateEq }>(() => ({ eq: updateEq }));
  const maybeSingle = vi.fn<() => Promise<{ data: { started_at: string } | null; error: DbError | null }>>(
    async () => ({ data: null, error: null }));
  const selectEq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq: selectEq }));
  const from = vi.fn(() => ({ insert, update, delete: del, select }));
  let uid: string | null = "u1";
  return {
    insert, update, updateEq, updateSelect, del, delEq, select, maybeSingle, from,
    currentUserId: () => uid, setUid: (v: string | null) => { uid = v; },
  };
});

vi.mock("../supabase", () => ({ supabase: { from: h.from } }));
vi.mock("../db", () => ({ currentUserId: h.currentUserId }));

import {
  LIVE_PUBLISH_INTERVAL_MS, canPublishNow, clearStaleLiveRun, endLiveRun,
  publishLiveRun, resetLivePublisher, shouldPublish, sweepOwnLiveRun,
} from "./publisher";
import { storeShareToken } from "./shareLink";

const START = 1_700_000_000_000;
const STARTED_ISO = new Date(START).toISOString();
const args = (status: "live" | "paused" | "ended" = "live") => ({
  status,
  points: [[1, 2, START, null] as const],
  stats: { km: 1, durationSec: 300, avgPace: 300, curPace: 300 },
  startedAt: START,
});
// Open a broadcast so the module is in its "continuing a run" state.
const openBroadcast = async () => {
  await publishLiveRun(args());
  vi.clearAllMocks();
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  h.setUid("u1");
  h.insert.mockResolvedValue({ error: null });
  h.delEq.mockResolvedValue({ error: null });
  h.updateSelect.mockResolvedValue({ data: [{ user_id: "u1" }], error: null });
  h.maybeSingle.mockResolvedValue({ data: null, error: null });
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
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(h.update).not.toHaveBeenCalled();

    vi.setSystemTime(START + LIVE_PUBLISH_INTERVAL_MS);
    await publishLiveRun(args());
    expect(h.update).toHaveBeenCalledTimes(1);
  });

  it("opens a broadcast with an INSERT, stamping started_at", async () => {
    await publishLiveRun(args());
    expect(h.insert.mock.calls[0][0]).toMatchObject({ user_id: "u1", status: "live", started_at: STARTED_ISO });
  });

  it("continues a broadcast with an UPDATE, never an upsert", async () => {
    // The premium gate lives on the INSERT policy, and Postgres applies an INSERT
    // policy's WITH CHECK to every row PROPOSED for insertion — so an upsert would
    // be gated on the continue path too, and an entitlement lapsing mid-run would
    // take the run off the air. Continuing must go through the ungated UPDATE.
    await openBroadcast();
    vi.setSystemTime(START + LIVE_PUBLISH_INTERVAL_MS);
    await publishLiveRun(args());
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledTimes(1);
    // started_at is left alone, so the original start instant survives.
    expect(h.update.mock.calls[0][0]).not.toHaveProperty("started_at");
    expect(h.updateEq).toHaveBeenCalledWith("user_id", "u1");
  });

  it("replaces a leftover row rather than failing to open the broadcast", async () => {
    h.insert.mockResolvedValueOnce({ error: { code: "23505" } });
    await publishLiveRun(args());
    expect(h.delEq).toHaveBeenCalledWith("user_id", "u1");
    expect(h.insert).toHaveBeenCalledTimes(2);
    // The new broadcast's clock is its own, not the leftover row's.
    expect(h.insert.mock.calls[1][0]).toMatchObject({ started_at: STARTED_ISO });
  });

  it("re-opens the row when an update matches nothing", async () => {
    // Another session ended the run out from under us — publishing into a void
    // for the rest of the run would leave the watcher on a frozen trace.
    await openBroadcast();
    h.updateSelect.mockResolvedValueOnce({ data: [], error: null });
    vi.setSystemTime(START + LIVE_PUBLISH_INTERVAL_MS);
    await publishLiveRun(args());
    vi.setSystemTime(START + LIVE_PUBLISH_INTERVAL_MS * 2);
    await publishLiveRun(args());
    expect(h.insert).toHaveBeenCalledTimes(1);
  });

  it("stops retrying after a policy rejection (a lapsed or absent entitlement)", async () => {
    h.insert.mockResolvedValue({ error: { code: "42501" } });
    await publishLiveRun(args());
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(canPublishNow("live")).toBe(false);

    vi.setSystemTime(START + LIVE_PUBLISH_INTERVAL_MS * 5);
    await publishLiveRun(args());
    expect(h.insert).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying after an ordinary failure, on the next interval", async () => {
    h.insert.mockResolvedValue({ error: { code: "500" } });
    await publishLiveRun(args());
    vi.setSystemTime(START + LIVE_PUBLISH_INTERVAL_MS);
    await publishLiveRun(args());
    expect(h.insert).toHaveBeenCalledTimes(2);
  });

  it("swallows a thrown transport error so recording is never affected", async () => {
    h.insert.mockRejectedValue(new Error("offline"));
    await expect(publishLiveRun(args())).resolves.toBeUndefined();
  });

  it("does nothing when signed out", async () => {
    h.setUid(null);
    await publishLiveRun(args());
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("marks this device as the publisher, only once the write lands", async () => {
    h.insert.mockResolvedValueOnce({ error: { code: "500" } });
    await publishLiveRun(args());
    expect(localStorage.getItem(LIVE_PUBLISHED_KEY)).toBeNull();

    vi.setSystemTime(START + LIVE_PUBLISH_INTERVAL_MS);
    await publishLiveRun(args());
    expect(localStorage.getItem(LIVE_PUBLISHED_KEY)).toBe(STARTED_ISO);
  });
});

describe("endLiveRun", () => {
  it("deletes the row and re-arms for the next run", async () => {
    await publishLiveRun(args());
    await endLiveRun();
    expect(h.delEq).toHaveBeenCalledWith("user_id", "u1");
    // Re-armed: the next run publishes immediately rather than waiting out the
    // previous run's throttle window.
    expect(canPublishNow("live")).toBe(true);
  });

  it("waits for a write already on the wire before deleting", async () => {
    // The "ended" write fired on Stop carries the whole trace. A delete that
    // overtakes it is undone the moment it lands, putting a saved-and-discarded
    // run back on the air.
    const order: string[] = [];
    let land: (() => void) | null = null;
    h.insert.mockImplementationOnce(() => new Promise(resolve => {
      land = () => { order.push("write"); resolve({ error: null }); };
    }));
    h.delEq.mockImplementation(async () => { order.push("delete"); return { error: null }; });

    void publishLiveRun(args());
    const ending = endLiveRun();
    expect(order).toEqual([]);
    land!();
    await ending;
    expect(order).toEqual(["write", "delete"]);
  });

  it("keeps the publisher marker when the delete doesn't land", async () => {
    // The boot sweep is the fallback, and it only runs for a device still holding
    // the marker — clearing it optimistically would strand the row forever.
    await publishLiveRun(args());
    h.delEq.mockResolvedValueOnce({ error: { code: "500" } });
    await endLiveRun();
    expect(localStorage.getItem(LIVE_PUBLISHED_KEY)).toBe(STARTED_ISO);

    await publishLiveRun(args());
    await endLiveRun();
    expect(localStorage.getItem(LIVE_PUBLISHED_KEY)).toBeNull();
  });
});

describe("sweepOwnLiveRun", () => {
  it("never touches a row this device didn't publish", async () => {
    // THE watcher case: the row is per-account, so a session that opens the app
    // to follow a run must not be the thing that deletes it.
    await sweepOwnLiveRun();
    expect(h.select).not.toHaveBeenCalled();
    expect(h.del).not.toHaveBeenCalled();
  });

  it("deletes the broadcast it left behind", async () => {
    localStorage.setItem(LIVE_PUBLISHED_KEY, STARTED_ISO);
    h.maybeSingle.mockResolvedValue({ data: { started_at: "2023-11-14T22:13:20+00:00" }, error: null });
    await sweepOwnLiveRun();
    expect(h.delEq).toHaveBeenCalledWith("user_id", "u1");
    expect(localStorage.getItem(LIVE_PUBLISHED_KEY)).toBeNull();
  });

  it("leaves a newer broadcast from another device alone", async () => {
    localStorage.setItem(LIVE_PUBLISHED_KEY, STARTED_ISO);
    h.maybeSingle.mockResolvedValue({ data: { started_at: new Date(START + 60000).toISOString() }, error: null });
    await sweepOwnLiveRun();
    expect(h.del).not.toHaveBeenCalled();
    // Our row is demonstrably gone, so the marker has nothing left to protect.
    expect(localStorage.getItem(LIVE_PUBLISHED_KEY)).toBeNull();
  });

  it("keeps the marker when the row can't be read", async () => {
    localStorage.setItem(LIVE_PUBLISHED_KEY, STARTED_ISO);
    h.maybeSingle.mockResolvedValue({ data: null, error: { code: "500" } });
    await sweepOwnLiveRun();
    expect(h.del).not.toHaveBeenCalled();
    expect(localStorage.getItem(LIVE_PUBLISHED_KEY)).toBe(STARTED_ISO);
  });
});

describe("public share link", () => {
  const TOKEN = "a".repeat(22);
  const OTHER = "b".repeat(22);
  const tokenArgs = (shareToken: string | null, onShareTokenRejected?: () => void) =>
    ({ ...args(), shareToken, onShareTokenRejected });
  // What PostgREST hands back when the partial unique index on share_token
  // rejects the write (someone else already holds that token).
  const tokenConflict = { code: "23505", message: 'duplicate key value violates unique constraint "live_runs_share_token_key"' };

  it("carries the token on the opening insert", async () => {
    await publishLiveRun(tokenArgs(TOKEN));
    expect(h.insert.mock.calls[0][0]).toMatchObject({ share_token: TOKEN });
  });

  it("carries it on every continuing update, so a revoke lands too", async () => {
    await publishLiveRun(tokenArgs(TOKEN));
    vi.clearAllMocks();
    vi.setSystemTime(START + LIVE_PUBLISH_INTERVAL_MS);
    await publishLiveRun(tokenArgs(null));
    expect(h.update.mock.calls[0][0]).toMatchObject({ share_token: null });
  });

  it("writes null when no link was ever minted (v1 behaviour is untouched)", async () => {
    await publishLiveRun(args());
    expect(h.insert.mock.calls[0][0]).toMatchObject({ share_token: null });
  });

  it("lets a token change jump the throttle", async () => {
    // Minting is an explicit act the runner is about to act on, and REVOKING has
    // to take the run off the public link now, not up to 30s from now. Neither
    // is driven by GPS, so nothing else would push it out promptly.
    expect(shouldPublish({
      now: START + 1, lastAt: START, status: "live", prevStatus: "live", busy: false,
      shareToken: TOKEN, prevShareToken: null,
    })).toBe(true);

    await publishLiveRun(tokenArgs(null));
    vi.clearAllMocks();
    vi.setSystemTime(START + 1000); // far inside the throttle window
    await publishLiveRun(tokenArgs(TOKEN));
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0]).toMatchObject({ share_token: TOKEN });
  });

  it("goes on the air without the link when the token is already taken", async () => {
    // Someone handed a link can squat its token. Losing the link is acceptable;
    // losing the broadcast is not.
    const onShareTokenRejected = vi.fn();
    storeShareToken(TOKEN);
    h.insert.mockResolvedValueOnce({ error: tokenConflict });
    await publishLiveRun(tokenArgs(TOKEN, onShareTokenRejected));

    expect(h.insert).toHaveBeenCalledTimes(2);
    expect(h.insert.mock.calls[1][0]).toMatchObject({ share_token: null });
    // NOT the leftover-own-row path: our row is fine, the token isn't.
    expect(h.del).not.toHaveBeenCalled();
    expect(onShareTokenRejected).toHaveBeenCalledOnce();
    expect(localStorage.getItem(LIVE_SHARE_TOKEN_KEY)).toBeNull();
  });

  it("still replaces a leftover row of its own on a plain key conflict", async () => {
    h.insert.mockResolvedValueOnce({ error: { code: "23505", message: "live_runs_pkey" } });
    await publishLiveRun(tokenArgs(TOKEN));
    expect(h.delEq).toHaveBeenCalledWith("user_id", "u1");
    expect(h.insert.mock.calls[1][0]).toMatchObject({ share_token: TOKEN });
  });

  it("drops a squatted token on the update path too", async () => {
    await openBroadcast();
    h.updateSelect.mockResolvedValueOnce({ data: null, error: tokenConflict });
    vi.setSystemTime(START + LIVE_PUBLISH_INTERVAL_MS);
    await publishLiveRun(tokenArgs(TOKEN));
    expect(h.update).toHaveBeenCalledTimes(2);
    expect(h.update.mock.calls[1][0]).toMatchObject({ share_token: null });
  });

  it("spends the token when the run ends", async () => {
    // A token outliving its run would be republished by the NEXT one, silently
    // reopening a link for a run the runner never shared.
    storeShareToken(TOKEN);
    await publishLiveRun(tokenArgs(TOKEN));
    await endLiveRun();
    expect(localStorage.getItem(LIVE_SHARE_TOKEN_KEY)).toBeNull();
  });

  it("spends it on a sweep as well", async () => {
    storeShareToken(TOKEN);
    localStorage.setItem(LIVE_PUBLISHED_KEY, STARTED_ISO);
    h.maybeSingle.mockResolvedValue({ data: { started_at: STARTED_ISO }, error: null });
    await sweepOwnLiveRun();
    expect(localStorage.getItem(LIVE_SHARE_TOKEN_KEY)).toBeNull();
  });

  it("keeps the stored token across a publisher reset, so a recovered run keeps its link", async () => {
    // The app was killed mid-run: the resumed run has to republish under the
    // link that has already been sent to someone.
    storeShareToken(TOKEN);
    resetLivePublisher();
    expect(localStorage.getItem(LIVE_SHARE_TOKEN_KEY)).toBe(TOKEN);
  });

  it("does not confuse a token change with a status change", async () => {
    await publishLiveRun(tokenArgs(TOKEN));
    vi.clearAllMocks();
    vi.setSystemTime(START + 1000);
    await publishLiveRun(tokenArgs(TOKEN)); // same token, same status, inside the window
    expect(h.update).not.toHaveBeenCalled();
    await publishLiveRun(tokenArgs(OTHER));
    expect(h.update).toHaveBeenCalledTimes(1);
  });
});

describe("clearStaleLiveRun", () => {
  const buffer = (savedAt: number) => JSON.stringify({ points: [[1, 2, START, null]], savedAt });

  beforeEach(() => {
    localStorage.setItem(LIVE_PUBLISHED_KEY, STARTED_ISO);
    h.maybeSingle.mockResolvedValue({ data: { started_at: STARTED_ISO }, error: null });
  });

  it("deletes an orphan row when no run is recoverable", async () => {
    await clearStaleLiveRun();
    expect(h.delEq).toHaveBeenCalledWith("user_id", "u1");
  });

  it("leaves the row alone while a recoverable run buffer exists", async () => {
    // That run can still be resumed, and a watcher may be following it.
    localStorage.setItem(LIVE_RUN_KEY, buffer(START));
    await clearStaleLiveRun();
    expect(h.del).not.toHaveBeenCalled();
  });

  it("sweeps once the buffer is too old to resume", async () => {
    // useRunTracker will drop this buffer on its next mount, so it must not keep
    // a broadcast on the air in the meantime.
    localStorage.setItem(LIVE_RUN_KEY, buffer(START - RESUME_MAX_AGE_MS - 1));
    await clearStaleLiveRun();
    expect(h.delEq).toHaveBeenCalledWith("user_id", "u1");
  });

  it("ignores a malformed buffer rather than skipping the sweep", async () => {
    localStorage.setItem(LIVE_RUN_KEY, "{not json");
    await clearStaleLiveRun();
    expect(h.delEq).toHaveBeenCalledWith("user_id", "u1");
  });
});
