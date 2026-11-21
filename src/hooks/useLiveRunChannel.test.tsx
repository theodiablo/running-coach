import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";

// Every open session's channel is a Realtime connection the plan caps; these pin when one is held.
const rt = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  opened: 0,
  removed: 0,
  reads: 0,
}));

vi.mock("../supabase", () => {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: () => { rt.reads++; return Promise.resolve({ data: rt.row, error: null }); },
  };
  type Ch = { cb?: (s: string) => void; on: () => Ch; subscribe: (cb: (s: string) => void) => Ch };
  const makeChannel = (): Ch => {
    const ch: Ch = {
      on: () => ch,
      subscribe: cb => { ch.cb = cb; rt.opened++; queueMicrotask(() => cb("SUBSCRIBED")); return ch; },
    };
    return ch;
  };
  return {
    supabase: {
      from: () => query,
      channel: makeChannel,
      // supabase-js reports the teardown to the OLD callback later, after a new channel may be up.
      removeChannel: (ch: Ch) => { rt.removed++; setTimeout(() => ch.cb?.("CLOSED"), 1000); return Promise.resolve(); },
    },
  };
});

import { useLiveRun } from "./useLiveRun";

const liveRow = () => ({
  user_id: "u1", status: "live", started_at: new Date().toISOString(),
  updated_at: new Date().toISOString(), points: [], stats: {},
});

let hidden = false;
beforeEach(() => {
  rt.row = null; rt.opened = 0; rt.removed = 0; rt.reads = 0; hidden = false;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
});
afterEach(cleanup);

const setHidden = (h: boolean) => act(() => {
  hidden = h;
  document.dispatchEvent(new Event("visibilitychange"));
});

describe("useLiveRun channel", () => {
  it("holds no channel for an account that has never gone on air, but still reads once", async () => {
    const { result } = renderHook(() => useLiveRun("u1", false));
    await waitFor(() => expect(result.current.row).toBeNull());
    expect(rt.opened).toBe(0);
  });

  it("opens one when that read finds a run live, so its updates still arrive", async () => {
    rt.row = liveRow();
    const { result } = renderHook(() => useLiveRun("u1", false));
    await waitFor(() => expect(result.current.active).toBe(true));
    expect(rt.opened).toBe(1);
  });

  it("subscribes for an account that has shared, and drops the channel while hidden", async () => {
    renderHook(() => useLiveRun("u1", true));
    await waitFor(() => expect(rt.opened).toBe(1));
    setHidden(true);
    expect(rt.removed).toBe(1);
    setHidden(false);
    await waitFor(() => expect(rt.opened).toBe(2));
  });

  it("reads a run that started while hidden on return", async () => {
    const { result } = renderHook(() => useLiveRun("u1", false));
    await waitFor(() => expect(result.current.row).toBeNull());
    setHidden(true);
    rt.row = liveRow();
    setHidden(false);
    await waitFor(() => expect(result.current.active).toBe(true));
  });

  it("does not read a deliberate teardown as Realtime failing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderHook(() => useLiveRun("u1", true));
      await waitFor(() => expect(rt.opened).toBe(1));
      setHidden(true);
      setHidden(false);
      await waitFor(() => expect(rt.opened).toBe(2));
      await act(async () => { vi.advanceTimersByTime(2000); });
      const before = rt.reads;
      // A fallback poll would read every 2 min; none may run once the new channel is up.
      await act(async () => { vi.advanceTimersByTime(250000); });
      expect(rt.reads).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
