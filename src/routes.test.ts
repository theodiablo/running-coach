// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// The offline route queue: on a weak network flushes overlap (boot, then every
// `online` event) and uploads crawl, so the queue must never be rewritten from
// a stale copy nor uploaded twice.

const h = vi.hoisted(() => ({
  insert: vi.fn(),
  del: vi.fn(async () => ({ error: null })),
}));

vi.mock("./supabase", () => ({
  supabase: {
    from: () => ({
      insert: (row: unknown) => ({ select: () => ({ single: () => h.insert(row) }) }),
      delete: () => ({ eq: h.del }),
    }),
  },
}));
vi.mock("./db", () => ({ currentUserId: () => "u1" }));

import { flushPendingRoutes, queuePendingRoute, removePendingRoute, getPendingRoute } from "./routes";

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};
const trace = (tmpId: string) => ({ tmpId, points: [[0, 0, 0, null]] as never, stats: {} });

describe("flushPendingRoutes", () => {
  beforeEach(() => {
    localStorage.clear();
    h.insert.mockReset();
    h.del.mockClear();
  });

  it("uploads each queued trace once, however many flushes overlap", async () => {
    queuePendingRoute(trace("rt1"));
    const upload = deferred<{ data: { id: string }; error: null }>();
    h.insert.mockReturnValueOnce(upload.promise);
    const saved = vi.fn();
    const a = flushPendingRoutes(saved);
    const b = flushPendingRoutes(saved);
    upload.resolve({ data: { id: "r1" }, error: null });
    await Promise.all([a, b]);
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(saved).toHaveBeenCalledWith("rt1", "r1");
    expect(getPendingRoute("rt1")).toBeNull();
  });

  it("keeps a trace queued while an earlier one was uploading", async () => {
    queuePendingRoute(trace("rt1"));
    const upload = deferred<{ data: { id: string }; error: null }>();
    h.insert.mockReturnValueOnce(upload.promise);
    const flushing = flushPendingRoutes();
    queuePendingRoute(trace("rt2")); // a run saved offline mid-flush
    h.insert.mockResolvedValueOnce({ data: null, error: { message: "offline" } });
    upload.resolve({ data: { id: "r1" }, error: null });
    await flushing;
    expect(getPendingRoute("rt1")).toBeNull();
    expect(getPendingRoute("rt2")).not.toBeNull();
    expect(h.insert).toHaveBeenCalledTimes(2); // tried in the same pass, not left for the next trigger
  });

  it("keeps failed uploads queued", async () => {
    queuePendingRoute(trace("rt1"));
    h.insert.mockResolvedValueOnce({ data: null, error: { message: "offline" } });
    await flushPendingRoutes();
    expect(getPendingRoute("rt1")).not.toBeNull();
  });

  it("deletes the uploaded row when its run was deleted mid-upload", async () => {
    queuePendingRoute(trace("rt1"));
    const upload = deferred<{ data: { id: string }; error: null }>();
    h.insert.mockReturnValueOnce(upload.promise);
    const saved = vi.fn();
    const flushing = flushPendingRoutes(saved);
    removePendingRoute("rt1");
    upload.resolve({ data: { id: "r1" }, error: null });
    await flushing;
    expect(saved).not.toHaveBeenCalled();
    expect(h.del).toHaveBeenCalledWith("id", "r1");
  });
});
