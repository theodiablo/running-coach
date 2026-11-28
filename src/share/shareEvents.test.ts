import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const track = vi.fn();

async function load(platform = "web") {
  vi.resetModules();
  vi.doMock("../supabase", () => ({ supabase: { rpc } }));
  vi.doMock("../native", () => ({ platform }));
  vi.doMock("../telemetry", () => ({ track }));
  return await import("./shareEvents");
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ error: null });
});

describe("share counter", () => {
  it("sends enums only: no user, run or session id ever reaches the counter", async () => {
    const ev = await load("android");
    ev.shareOpened("finish", "route");
    ev.shareHandedOff("shared", "finish", "route", "week", true);
    ev.shareClosed("detail", "number", "number");
    expect(rpc.mock.calls.map(c => c[0])).toEqual(["share_card_count", "share_card_count", "share_card_count"]);
    expect(rpc.mock.calls.map(c => c[1])).toEqual([
      { p_event: "opened", p_entry: "finish", p_preselected: "route", p_chosen: null, p_first_share: null, p_platform: "android" },
      { p_event: "shared", p_entry: "finish", p_preselected: "route", p_chosen: "week", p_first_share: true, p_platform: "android" },
      { p_event: "closed", p_entry: "detail", p_preselected: "number", p_chosen: "number", p_first_share: false, p_platform: "android" },
    ]);
  });

  it("files any browser under web", async () => {
    (await load("web")).shareOpened("detail", "number");
    expect(rpc.mock.calls[0][1].p_platform).toBe("web");
  });

  it("sends the two consent-gated events, and none for a close", async () => {
    const ev = await load();
    ev.shareOpened("finish", "route");
    ev.shareHandedOff("saved", "detail", "number", "route", false);
    ev.shareClosed("detail", "number", "number");
    expect(track.mock.calls).toEqual([
      ["share_card_opened", { entry: "finish", preselected: "route" }],
      ["share_card_shared", { entry: "detail", preselected: "number", chosen: "route", event: "saved" }],
    ]);
  });

  it("drops a failed count without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rpc.mockResolvedValue({ error: { message: "denied" } });
    const ev = await load();
    expect(() => ev.shareOpened("finish", "route")).not.toThrow();
    rpc.mockRejectedValue(new Error("offline"));
    expect(() => ev.shareOpened("finish", "route")).not.toThrow();
    rpc.mockImplementationOnce(() => { throw new Error("no client"); });
    expect(() => ev.shareOpened("finish", "route")).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith("share_card_count failed", "denied");
  });
});
