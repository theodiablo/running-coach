import { beforeEach, describe, it, expect, vi } from "vitest";
import { BATTERY_NUDGE_KEY } from "../constants";

// Force the Android path and stub the native RunPermissions bridge.
vi.mock("../native", () => ({ isNative: true, isAndroid: true, isIos: false, platform: "android" }));
const native = { checkBatteryOptimization: vi.fn(), openBatteryOptimizationSettings: vi.fn(), checkPowerSaveMode: vi.fn() };
vi.mock("@capacitor/core", () => ({ registerPlugin: () => native }));

import { markBatteryNudgeDismissed, powerStateSummary, shouldNudgeBatteryOptimization } from "./battery";

beforeEach(() => {
  localStorage.clear();
  native.checkBatteryOptimization.mockReset();
  native.openBatteryOptimizationSettings.mockReset();
  native.checkPowerSaveMode.mockReset();
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

describe("powerStateSummary", () => {
  it("reports both halves of the regime, which are different settings", async () => {
    native.checkPowerSaveMode.mockResolvedValue({ powerSaveMode: true });
    native.checkBatteryOptimization.mockResolvedValue({ ignoringOptimizations: true });
    await expect(powerStateSummary()).resolves.toBe("saver=true unrestricted=true");
  });

  it("reads a missing answer as off, never as true", async () => {
    native.checkPowerSaveMode.mockResolvedValue({});
    native.checkBatteryOptimization.mockResolvedValue({});
    await expect(powerStateSummary()).resolves.toBe("saver=false unrestricted=false");
  });

  it("says nothing rather than guessing when the bridge fails", async () => {
    native.checkPowerSaveMode.mockRejectedValue(new Error("no plugin"));
    native.checkBatteryOptimization.mockResolvedValue({ ignoringOptimizations: true });
    await expect(powerStateSummary()).resolves.toBeNull();
  });
});
