import { describe, it, expect } from "vitest";
import { compareVersions, versionStatus, resolveAppUpdate, reviewChannelFor, requiredUpdatePending, withInstallState } from "./version";

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

describe("reviewChannelFor", () => {
  it("Android store installs get the app's own card", () => {
    expect(reviewChannelFor("android", true, "1.2.0", "1.2.0", false)).toEqual({ prompt: "card", link: true });
  });

  it("asks nobody whose review couldn't be public", () => {
    expect(reviewChannelFor("android", false, "1.2.0", "1.2.0", false)).toBeNull();
    // A Play tester on a build ahead of production.
    expect(reviewChannelFor("android", true, "1.3.0", "1.2.0", false)).toBeNull();
    expect(reviewChannelFor("ios", false, "1.2.0", null, true)).toBeNull();
  });

  it("iOS uses Apple's own sheet, and links to the listing only once it exists", () => {
    expect(reviewChannelFor("ios", true, "1.2.0", null, false)).toEqual({ prompt: "native", link: false });
    expect(reviewChannelFor("ios", true, "1.2.0", null, true)).toEqual({ prompt: "native", link: true });
  });
});

describe("requiredUpdatePending", () => {
  const play = (o: Partial<{ available: boolean; inProgress: boolean; status: string }> = {}) =>
    ({ available: false, inProgress: false, status: "unknown", ...o });

  it("Android: pending while Play has nothing to offer this install yet", () => {
    expect(requiredUpdatePending(play(), null, "1.3.0")).toBe(true);
    expect(requiredUpdatePending(play({ available: true }), null, "1.3.0")).toBe(false);
    expect(requiredUpdatePending(play({ status: "downloaded" }), null, "1.3.0")).toBe(false);
  });

  it("iOS: pending while the live App Store version is below the floor", () => {
    expect(requiredUpdatePending(null, "1.2.0", "1.3.0")).toBe(true);
    expect(requiredUpdatePending(null, "1.3.0", "1.3.0")).toBe(false);
  });

  it("unknown means not pending: the store button stays", () => {
    expect(requiredUpdatePending(null, undefined, "1.3.0")).toBe(false);
  });
});

describe("withInstallState", () => {
  const play = { via: "play" as const, versionCode: 42, status: "unknown", progress: null };
  const ev = (status: string, bytesDownloaded = 0, totalBytes = 0) => ({ status, bytesDownloaded, totalBytes });

  it("follows a live download to the restart", () => {
    expect(withInstallState(play, ev("downloading", 21, 42))).toEqual({ ...play, status: "downloading", progress: 0.5 });
    expect(withInstallState(play, ev("downloaded", 42, 42))).toMatchObject({ status: "downloaded" });
    expect(withInstallState(play, ev("installed"))).toBeNull();
  });

  it("an event that landed before launch finished still reaches the card", () => {
    expect(withInstallState(play, ev("downloaded", 42, 42), false)).toMatchObject({ status: "downloaded" });
  });

  it("but a stale cancel never hides a fresh offer", () => {
    expect(withInstallState(play, ev("canceled"), false)).toBe(play);
  });

  it("leaves a store card alone", () => {
    const store = { via: "store" as const, version: "1.2.0" };
    expect(withInstallState(store, ev("downloaded"))).toBe(store);
  });
});
