import { beforeEach, describe, it, expect, vi } from "vitest";
import { BATTERY_NUDGE_KEY } from "../constants";

// Force the Android path and stub the native RunPermissions bridge.
vi.mock("../native", () => ({ isNative: true, isAndroid: true, isIos: false, platform: "android" }));
const native = { checkBatteryOptimization: vi.fn(), openBatteryOptimizationSettings: vi.fn() };
vi.mock("@capacitor/core", () => ({ registerPlugin: () => native }));

import { markBatteryNudgeDismissed, shouldNudgeBatteryOptimization } from "./battery";

beforeEach(() => {
  localStorage.clear();
  native.checkBatteryOptimization.mockReset();
  native.openBatteryOptimizationSettings.mockReset();
});

describe("shouldNudgeBatteryOptimization", () => {
  it("nudges when the app is battery-optimized and not yet asked", async () => {
    native.checkBatteryOptimization.mockResolvedValue({ ignoringOptimizations: false });
    await expect(shouldNudgeBatteryOptimization()).resolves.toBe(true);
  });

  it("stays quiet once dismissed", async () => {
    native.checkBatteryOptimization.mockResolvedValue({ ignoringOptimizations: false });
    markBatteryNudgeDismissed();
    expect(localStorage.getItem(BATTERY_NUDGE_KEY)).toBe("1");
    await expect(shouldNudgeBatteryOptimization()).resolves.toBe(false);
    expect(native.checkBatteryOptimization).not.toHaveBeenCalled();
  });

  it("stays quiet when the app is already exempt", async () => {
    native.checkBatteryOptimization.mockResolvedValue({ ignoringOptimizations: true });
    await expect(shouldNudgeBatteryOptimization()).resolves.toBe(false);
  });

  it("never throws (and never nags) when the bridge fails", async () => {
    native.checkBatteryOptimization.mockRejectedValue(new Error("boom"));
    await expect(shouldNudgeBatteryOptimization()).resolves.toBe(false);
  });
});
