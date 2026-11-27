import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.fn();
const from = vi.fn(() => ({ insert }));
const track = vi.fn();

async function load(platform = "web") {
  vi.resetModules();
  vi.doMock("../supabase", () => ({ supabase: { from } }));
  vi.doMock("../native", () => ({ platform }));
  vi.doMock("../telemetry", () => ({ track }));
  return await import("./shareEvents");
}

beforeEach(() => {
  vi.clearAllMocks();
  insert.mockResolvedValue({ error: null });
});

describe("share counter", () => {
  it("writes enums only: no user, run or session id ever reaches the row", async () => {
    const ev = await load("android");
    ev.shareOpened("finish", "route");
    ev.shareHandedOff("shared", "finish", "route", "week", true);
    ev.shareClosed("detail", "number", "number");
    expect(from).toHaveBeenCalledWith("share_card_events");
    expect(insert.mock.calls.map(c => c[0])).toEqual([
      { event: "opened", entry: "finish", preselected: "route", platform: "android" },
      { event: "shared", entry: "finish", preselected: "route", chosen: "week", first_share: true, platform: "android" },
      { event: "closed", entry: "detail", preselected: "number", chosen: "number", first_share: false, platform: "android" },
    ]);
  });

  it("files any browser under web", async () => {
    (await load("web")).shareOpened("detail", "number");
    expect(insert.mock.calls[0][0].platform).toBe("web");
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

  it("drops a failed insert without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    insert.mockResolvedValue({ error: { message: "denied" } });
    const ev = await load();
    expect(() => ev.shareOpened("finish", "route")).not.toThrow();
    insert.mockRejectedValue(new Error("offline"));
    expect(() => ev.shareOpened("finish", "route")).not.toThrow();
    from.mockImplementationOnce(() => { throw new Error("no client"); });
    expect(() => ev.shareOpened("finish", "route")).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith("share_card_events insert failed", "denied");
  });
});
