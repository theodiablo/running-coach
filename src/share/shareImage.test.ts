// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { shareImage, shareLink, sharesFiles } from "./shareImage";

const blob = new Blob(["png"], { type: "image/png" });
const nav = navigator as unknown as { share?: unknown; canShare?: unknown };

afterEach(() => {
  delete nav.share;
  delete nav.canShare;
  vi.restoreAllMocks();
});

describe("shareImage", () => {
  it("hands the file and the text to the share sheet when the browser takes files", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.assign(nav, { share, canShare: () => true });
    expect(await shareImage(blob, "run.png", "Tracked with Running Coach: https://x")).toBe("shared");
    const payload = share.mock.calls[0][0];
    expect(payload.files[0].name).toBe("run.png");
    expect(payload.text).toBe("Tracked with Running Coach: https://x");
  });

  it("tags the link with the card style for the /get redirect's counts", () => {
    expect(shareLink("number")).toBe("https://run.camboulive.solutions/get?src=share-number");
  });

  it("reads a dismissed sheet as a decision, not a failure", async () => {
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
    Object.assign(nav, { share: vi.fn().mockRejectedValue(abort), canShare: () => true });
    expect(await shareImage(blob, "run.png")).toBe("dismissed");
  });

  it("downloads when the share sheet refuses an expired tap", async () => {
    const denied = Object.assign(new Error("no activation"), { name: "NotAllowedError" });
    Object.assign(nav, { share: vi.fn().mockRejectedValue(denied), canShare: () => true });
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    expect(await shareImage(blob, "run.png")).toBe("saved");
    expect(click).toHaveBeenCalled();
  });

  it("reports any other share error as failed", async () => {
    Object.assign(nav, { share: vi.fn().mockRejectedValue(new Error("nope")), canShare: () => true });
    expect(await shareImage(blob, "run.png")).toBe("failed");
  });

  it("downloads where files can't be shared", async () => {
    Object.assign(nav, { share: vi.fn(), canShare: () => false });
    const created = vi.fn(() => "blob:x");
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    expect(sharesFiles()).toBe(false);
    expect(await shareImage(blob, "run.png")).toBe("saved");
    expect(click).toHaveBeenCalled();
    expect(nav.share).not.toHaveBeenCalled();
  });
});
