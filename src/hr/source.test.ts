import { describe, it, expect, vi } from "vitest";

// getHrSource reads the platform consts at call time, so each case reloads the
// module graph with a different mocked src/native.ts — the same seam the app
// resolves once at boot.
async function loadSource(platform: "web" | "android" | "ios") {
  vi.resetModules();
  vi.doMock("../native", () => ({
    isNative: platform !== "web",
    isAndroid: platform === "android",
    isIos: platform === "ios",
    platform,
  }));
  return await import("./source");
}

describe("getHrSource platform matrix", () => {
  it("web: every method degrades to null", async () => {
    const { getHrSource } = await loadSource("web");
    for (const m of ["off", "bluetooth", "healthconnect", "healthkit", "garbage", null, undefined]) {
      expect(getHrSource(m as string)).toBeNull();
    }
  });

  it("android: bluetooth + healthconnect resolve, healthkit degrades to off", async () => {
    const { getHrSource } = await loadSource("android");
    expect(getHrSource("bluetooth")?.id).toBe("bluetooth");
    expect(getHrSource("healthconnect")?.id).toBe("healthconnect");
    // Synced from an iPhone — must not reach a bridge that doesn't exist here.
    expect(getHrSource("healthkit")).toBeNull();
    expect(getHrSource("off")).toBeNull();
  });

  it("ios: bluetooth resolves, healthconnect degrades to off", async () => {
    const { getHrSource } = await loadSource("ios");
    expect(getHrSource("bluetooth")?.id).toBe("bluetooth");
    // Synced from an Android phone — Health Connect is Android-only.
    expect(getHrSource("healthconnect")).toBeNull();
    expect(getHrSource("off")).toBeNull();
  });
});

