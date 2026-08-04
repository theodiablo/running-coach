import { describe, it, expect, vi } from "vitest";
import { WEB_APP_ORIGIN } from "../constants";

vi.mock("../native", () => ({ isNative: true, isAndroid: true, isIos: false, platform: "android" }));

import { watchUrl } from "./shareLink";

// The shell's own origin (capacitor://localhost) is unreachable from a browser,
// so a link minted in the native app must point at the web app — the platform
// where runs are actually recorded is where this default matters most.
describe("watchUrl in the native shell", () => {
  it("mints against the web origin, never the shell's", () => {
    const token = "a".repeat(22);
    expect(watchUrl(token)).toBe(`${WEB_APP_ORIGIN}/watch/${token}`);
  });
});
