import { describe, it, expect, beforeEach, vi } from "vitest";
import { LIVE_SHARE_LINK_KEY } from "../constants";

// The ledger is what makes a DURABLE link safe: the claim is permanent, so
// nobody handed the link can take the token, and rotation is one transaction so
// an account can never be left with no link at all. These tests drive those
// decisions against a mocked client — no network, no real ledger.

const h = vi.hoisted(() => {
  type DbError = { code?: string; message?: string } | null;
  type Row = { token: string } | null;
  const maybeSingle = vi.fn<() => Promise<{ data: Row; error: DbError }>>(
    async () => ({ data: null, error: null }));
  const is = vi.fn(() => ({ maybeSingle }));
  const eq = vi.fn(() => ({ is, maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const insert = vi.fn<(row: Record<string, unknown>) => Promise<{ error: DbError }>>(
    async () => ({ error: null }));
  const from = vi.fn(() => ({ select, insert }));
  const rpc = vi.fn<(fn: string, params: Record<string, unknown>) =>
    Promise<{ data: unknown; error: DbError }>>(async (_fn, params) =>
      ({ data: { token: params.p_new_token }, error: null }));
  let uid: string | null = "u1";
  return {
    maybeSingle, is, eq, select, insert, from, rpc,
    currentUserId: vi.fn(() => uid),
    setUid: (v: string | null) => { uid = v; },
  };
});

vi.mock("../supabase", () => ({ supabase: { from: h.from, rpc: h.rpc } }));
vi.mock("../db", () => ({ currentUserId: h.currentUserId }));

import {
  clearShareLinkCache, ensureShareLink, fetchShareLink, readCachedShareLink, rotateShareLink,
} from "./shareLinkStore";

const TOKEN = "a".repeat(22);
const OTHER = "b".repeat(22);
const activeConflict = {
  code: "23505",
  message: 'duplicate key value violates unique constraint "live_share_tokens_active_key"',
};
const tokenConflict = {
  code: "23505",
  message: 'duplicate key value violates unique constraint "live_share_tokens_pkey"',
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.setUid("u1");
  h.maybeSingle.mockResolvedValue({ data: null, error: null });
  h.insert.mockResolvedValue({ error: null });
  h.rpc.mockImplementation(async (_fn, params) => ({ data: { token: params.p_new_token }, error: null }));
});

describe("ensureShareLink", () => {
  it("returns the account's existing link without claiming another", async () => {
    h.maybeSingle.mockResolvedValue({ data: { token: TOKEN }, error: null });
    expect(await ensureShareLink()).toBe(TOKEN);
    expect(h.insert).not.toHaveBeenCalled();
    expect(readCachedShareLink("u1")).toBe(TOKEN);
  });

  it("claims one when the ledger has none", async () => {
    const token = await ensureShareLink();
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(h.insert.mock.calls[0][0]).toMatchObject({ user_id: "u1", token });
    expect(readCachedShareLink("u1")).toBe(token);
  });

  it("never claims a second link when the read FAILED", async () => {
    // Offline is not an empty ledger. Inserting here would hit the active-row
    // index at best, and at worst claim a second address for one account.
    h.maybeSingle.mockResolvedValue({ data: null, error: { code: "PGRST000" } });
    expect(await ensureShareLink()).toBeNull();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("adopts the winner when another device claims one first", async () => {
    // Losing this race must not produce a second link or an error: re-read and
    // use theirs, which is the account's one address.
    h.insert.mockResolvedValueOnce({ error: activeConflict });
    h.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { token: OTHER }, error: null });
    expect(await ensureShareLink()).toBe(OTHER);
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(readCachedShareLink("u1")).toBe(OTHER);
  });

  it("re-mints on a token collision rather than giving up", async () => {
    h.insert.mockResolvedValueOnce({ error: tokenConflict });
    const token = await ensureShareLink();
    expect(h.insert).toHaveBeenCalledTimes(2);
    expect(token).toBe(h.insert.mock.calls[1][0].token);
    expect(h.insert.mock.calls[0][0].token).not.toBe(token);
  });

  it("does nothing signed out", async () => {
    h.setUid(null);
    expect(await ensureShareLink()).toBeNull();
    expect(h.insert).not.toHaveBeenCalled();
  });
});

describe("rotateShareLink", () => {
  it("goes through the one transactional RPC, minting the token here", async () => {
    const token = await rotateShareLink();
    expect(h.rpc).toHaveBeenCalledWith("rotate_share_link", { p_new_token: token });
    expect(readCachedShareLink("u1")).toBe(token);
  });

  it("trusts the row the server returns over the token it sent", async () => {
    h.rpc.mockResolvedValue({ data: [{ token: OTHER }], error: null });
    expect(await rotateShareLink()).toBe(OTHER);
    expect(readCachedShareLink("u1")).toBe(OTHER);
  });

  it("keeps the old link cached when the rotation fails", async () => {
    // The failure direction that matters: the runner still has a link they can
    // send, and the ledger still resolves it.
    localStorage.setItem(LIVE_SHARE_LINK_KEY, JSON.stringify({ uid: "u1", token: TOKEN }));
    h.rpc.mockResolvedValue({ data: null, error: { code: "PGRST000" } });
    expect(await rotateShareLink()).toBeNull();
    expect(readCachedShareLink("u1")).toBe(TOKEN);
  });
});

describe("the cache", () => {
  it("is ignored for a different account", async () => {
    // A shared device must never show (or send) the previous runner's address.
    localStorage.setItem(LIVE_SHARE_LINK_KEY, JSON.stringify({ uid: "u1", token: TOKEN }));
    expect(readCachedShareLink("u2")).toBeNull();
    expect(readCachedShareLink(null)).toBeNull();
  });

  it("ignores junk and a token of the wrong shape", () => {
    localStorage.setItem(LIVE_SHARE_LINK_KEY, "not json");
    expect(readCachedShareLink("u1")).toBeNull();
    localStorage.setItem(LIVE_SHARE_LINK_KEY, JSON.stringify({ uid: "u1", token: "short" }));
    expect(readCachedShareLink("u1")).toBeNull();
  });

  it("is spent by an explicit sign-out", () => {
    localStorage.setItem(LIVE_SHARE_LINK_KEY, JSON.stringify({ uid: "u1", token: TOKEN }));
    clearShareLinkCache();
    expect(readCachedShareLink("u1")).toBeNull();
  });

  it("keeps the confirmed copy when a revalidation can't reach the ledger", async () => {
    localStorage.setItem(LIVE_SHARE_LINK_KEY, JSON.stringify({ uid: "u1", token: TOKEN }));
    h.maybeSingle.mockResolvedValue({ data: null, error: { code: "PGRST000" } });
    expect(await fetchShareLink()).toBeNull(); // "couldn't establish", not "no link"
    expect(readCachedShareLink("u1")).toBe(TOKEN);
  });
});
