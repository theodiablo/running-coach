// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { shareImage, sharesFiles } from "./shareImage";

const blob = new Blob(["png"], { type: "image/png" });
const nav = navigator as unknown as { share?: unknown; canShare?: unknown };

afterEach(() => {
  delete nav.share;
  delete nav.canShare;
  vi.restoreAllMocks();
});

describe("shareImage", () => {
  it("hands the file alone to the share sheet when the browser takes files", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.assign(nav, { share, canShare: () => true });
    expect(await shareImage(blob, "run.png")).toBe("shared");
    const payload = share.mock.calls[0][0];
    expect(Object.keys(payload)).toEqual(["files"]);
    expect(payload.files[0].name).toBe("run.png");
  });

  it("reads a dismissed sheet as a decision, not a failure", async () => {
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
    Object.assign(nav, { share: vi.fn().mockRejectedValue(abort), canShare: () => true });
    expect(await shareImage(blob, "run.png")).toBe("dismissed");
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
