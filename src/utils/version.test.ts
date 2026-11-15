import { describe, it, expect } from "vitest";
import { compareVersions, versionStatus, resolveAppUpdate } from "./version";

describe("compareVersions", () => {
  it("orders by numeric segments (not lexically)", () => {
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1); // 2 < 10, not "2" > "1"
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });
  it("treats missing trailing segments as 0", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBe(1);
  });
  it("ignores pre-release suffixes", () => {
    expect(compareVersions("1.2.0-beta", "1.2.0")).toBe(0);
  });
});

describe("versionStatus", () => {
  const cfg = { min_supported_version: "1.0.0", latest_version: "1.5.0" };
  it("never blocks when version or config is unknown (e.g. web)", () => {
    expect(versionStatus(null, cfg)).toBe("ok");
    expect(versionStatus("1.5.0", null)).toBe("ok");
  });
  it("forces an update below the supported floor", () => {
    expect(versionStatus("0.9.0", cfg)).toBe("must-update");
  });
  it("nudges between the floor and latest", () => {
    expect(versionStatus("1.2.0", cfg)).toBe("update-available");
  });
  it("is ok at or above latest", () => {
    expect(versionStatus("1.5.0", cfg)).toBe("ok");
    expect(versionStatus("1.6.0", cfg)).toBe("ok");
  });
});

describe("resolveAppUpdate", () => {
  const playAnswer = (o: Partial<{ available: boolean; inProgress: boolean; flexibleAllowed: boolean; status: string }> = {}) =>
    ({ available: false, inProgress: false, flexibleAllowed: true, versionCode: 42, status: "unknown", ...o });

  it("Play is the truth on Android when it answers, over app_config", () => {
    expect(resolveAppUpdate("ok", null, playAnswer({ available: true }))).toEqual({ via: "play", versionCode: 42, status: "unknown", progress: null });
    // app_config flipped before Play has the build for this device: no dead "Update".
    expect(resolveAppUpdate("update-available", "1.2.0", playAnswer())).toBeNull();
  });

  it("keeps following a download already started", () => {
    expect(resolveAppUpdate("ok", null, playAnswer({ status: "downloaded" }))?.via).toBe("play");
    expect(resolveAppUpdate("ok", null, playAnswer({ inProgress: true }))?.via).toBe("play");
  });

  it("falls back to the store card when Play can't run a flexible flow", () => {
    expect(resolveAppUpdate("update-available", "1.2.0", playAnswer({ available: true, flexibleAllowed: false })))
      .toEqual({ via: "store", version: "1.2.0" });
  });

  it("uses app_config where no store answers (iOS, sideloaded)", () => {
    expect(resolveAppUpdate("update-available", "1.2.0", null)).toEqual({ via: "store", version: "1.2.0" });
    expect(resolveAppUpdate("ok", "1.2.0", null)).toBeNull();
  });

  it("leaves the hard gate to UpdateRequired", () => {
    expect(resolveAppUpdate("must-update", "1.2.0", playAnswer({ available: true }))).toBeNull();
  });
});
