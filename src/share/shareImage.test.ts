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

// Like registerPlugin's proxy: every property is a method, `then` included, and an
// unknown one rejects, so a promise resolved with the bare proxy never settles.
function capacitorProxy(name: string, methods: Record<string, unknown>) {
  return new Proxy({}, {
    get: (_, prop) => methods[prop as string]
      ?? (() => Promise.reject(new Error(`"${name}.${String(prop)}()" is not implemented on android`))),
  });
}

describe("shareImage in a native shell", () => {
  const writeFile = vi.fn();
  const share = vi.fn();
  let available: Record<string, boolean>;

  // isNative is a module-level const, so each case loads the seam fresh inside a shell.
  async function load() {
    vi.resetModules();
    vi.doMock("../native", () => ({ isNative: true }));
    vi.doMock("@capacitor/core", () => ({ Capacitor: { isPluginAvailable: (n: string) => !!available[n] } }));
    vi.doMock("@capacitor/filesystem", () => ({ Filesystem: capacitorProxy("Filesystem", { writeFile }), Directory: { Cache: "CACHE" } }));
    vi.doMock("@capacitor/share", () => ({ Share: capacitorProxy("Share", { share }) }));
    return await import("./shareImage");
  }

  afterEach(() => {
    vi.doUnmock("../native");
    vi.doUnmock("@capacitor/core");
    vi.doUnmock("@capacitor/filesystem");
    vi.doUnmock("@capacitor/share");
    writeFile.mockReset();
    share.mockReset();
  });

  it("writes the PNG to the cache and hands its file URI and the text to the share sheet", async () => {
    available = { Share: true, Filesystem: true };
    writeFile.mockResolvedValue({ uri: "file:///cache/run.png" });
    share.mockResolvedValue({ activityType: "" });
    const seam = await load();
    expect(seam.canShareImage()).toBe(true);
    expect(seam.opensShareSheet()).toBe(true);
    expect(await seam.shareImage(new Blob(["png"]), "run.png", "Tracked with Running Coach")).toBe("shared");
    expect(writeFile).toHaveBeenCalledWith({ path: "run.png", data: btoa("png"), directory: "CACHE" });
    expect(share).toHaveBeenCalledWith({ files: ["file:///cache/run.png"], text: "Tracked with Running Coach" });
  });

  it("never reaches for the browser's share or download inside a shell", async () => {
    available = { Share: true, Filesystem: true };
    writeFile.mockResolvedValue({ uri: "file:///cache/run.png" });
    share.mockResolvedValue({});
    const webShare = vi.fn();
    Object.assign(nav, { share: webShare, canShare: () => true });
    const seam = await load();
    expect(await seam.shareImage(blob, "run.png")).toBe("shared");
    expect(webShare).not.toHaveBeenCalled();
  });

  it("reads a closed sheet as a decision, not a failure", async () => {
    available = { Share: true, Filesystem: true };
    writeFile.mockResolvedValue({ uri: "file:///cache/run.png" });
    share.mockRejectedValue(new Error("Share canceled"));
    expect(await (await load()).shareImage(blob, "run.png")).toBe("dismissed");
  });

  it("fails when the file can't be written, without opening the sheet", async () => {
    available = { Share: true, Filesystem: true };
    writeFile.mockRejectedValue(new Error("disk full"));
    expect(await (await load()).shareImage(blob, "run.png")).toBe("failed");
    expect(share).not.toHaveBeenCalled();
  });

  it.each<Record<string, boolean>>([{ Share: true }, { Filesystem: true }, {}])("hides the share action when a plugin is missing (%o)", async (a) => {
    available = a;
    const seam = await load();
    expect(seam.canShareImage()).toBe(false);
    expect(seam.opensShareSheet()).toBe(false);
    expect(await seam.shareImage(blob, "run.png")).toBe("failed");
    expect(share).not.toHaveBeenCalled();
  });
});
