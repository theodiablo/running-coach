// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from "vitest";
import { BG_LOC_ASKED_KEY } from "../constants";

// Force the Android path and stub the native RunPermissions bridge.
vi.mock("../native", () => ({ isNative: true, isAndroid: true, isIos: false, platform: "android" }));
const native = { checkBackgroundLocation: vi.fn(), requestBackgroundLocation: vi.fn() };
vi.mock("@capacitor/core", () => ({ registerPlugin: () => native }));

import { ensureBackgroundLocationOnce } from "./background";

beforeEach(() => {
  localStorage.clear();
  native.checkBackgroundLocation.mockReset();
  native.requestBackgroundLocation.mockReset();
});

describe("ensureBackgroundLocationOnce", () => {
  it("no-ops when the permission isn't declared (web/iOS or a build without it) and never marks asked", async () => {
    native.checkBackgroundLocation.mockResolvedValue({ declared: false, granted: false });
    await ensureBackgroundLocationOnce();
    expect(native.requestBackgroundLocation).not.toHaveBeenCalled();
    expect(localStorage.getItem(BG_LOC_ASKED_KEY)).toBeNull();
  });

  it("requests once when declared but ungranted, then marks asked so it never re-nags", async () => {
    native.checkBackgroundLocation.mockResolvedValue({ declared: true, granted: false });
    native.requestBackgroundLocation.mockResolvedValue({ declared: true, granted: true });
    await ensureBackgroundLocationOnce();
    expect(native.requestBackgroundLocation).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(BG_LOC_ASKED_KEY)).toBe("1");

    await ensureBackgroundLocationOnce(); // second call short-circuits on the flag
    expect(native.requestBackgroundLocation).toHaveBeenCalledTimes(1);
    expect(native.checkBackgroundLocation).toHaveBeenCalledTimes(1);
  });

  it("skips the request when already granted, still marking asked", async () => {
    native.checkBackgroundLocation.mockResolvedValue({ declared: true, granted: true });
    await ensureBackgroundLocationOnce();
    expect(native.requestBackgroundLocation).not.toHaveBeenCalled();
    expect(localStorage.getItem(BG_LOC_ASKED_KEY)).toBe("1");
  });

  it("never throws when the native bridge fails", async () => {
    native.checkBackgroundLocation.mockRejectedValue(new Error("boom"));
    await expect(ensureBackgroundLocationOnce()).resolves.toBeUndefined();
    expect(localStorage.getItem(BG_LOC_ASKED_KEY)).toBeNull();
  });
});
