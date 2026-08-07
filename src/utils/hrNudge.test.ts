import { describe, it, expect } from "vitest";
import { hrNudgeFor, type HrNudgeInput } from "./hrNudge";

const base: HrNudgeInput = {
  isNative: true, isAndroid: true, isIos: false,
  hrMethod: "off",
  healthConnectAuthorized: false, healthKitAuthorized: false,
  pairedHrDevice: false, hrOptOut: false,
};

describe("hrNudgeFor", () => {
  it("never nudges on the web", () => {
    expect(hrNudgeFor({ ...base, isNative: false })).toBeNull();
  });

  it("offers the generic setup prompt when HR is off, and only that one opts out", () => {
    expect(hrNudgeFor(base)).toEqual({ id: "setup", allowOptOut: true });
    expect(hrNudgeFor({ ...base, hrOptOut: true })).toBeNull();
  });

  it("asks to re-authorize the health store the device actually owns", () => {
    expect(hrNudgeFor({ ...base, hrMethod: "healthconnect" }))
      .toEqual({ id: "auth", allowOptOut: false });
    expect(hrNudgeFor({ ...base, isAndroid: false, isIos: true, hrMethod: "healthkit" }))
      .toEqual({ id: "hkAuth", allowOptOut: false });
  });

  it("stays silent once the store is authorized", () => {
    expect(hrNudgeFor({ ...base, hrMethod: "healthconnect", healthConnectAuthorized: true })).toBeNull();
    expect(hrNudgeFor({ ...base, isAndroid: false, isIos: true, hrMethod: "healthkit", healthKitAuthorized: true })).toBeNull();
  });

  it("asks to pair a strap only while none is paired", () => {
    expect(hrNudgeFor({ ...base, hrMethod: "bluetooth" })).toEqual({ id: "pair", allowOptOut: false });
    expect(hrNudgeFor({ ...base, hrMethod: "bluetooth", pairedHrDevice: true })).toBeNull();
  });

  // The synced setting names an integration this device can't have. Neither the
  // re-authorize prompt (meaningless here) nor the generic setup prompt (the
  // method isn't "off", it's just unusable locally) may appear.
  it("shows nothing when the synced method belongs to the other platform", () => {
    expect(hrNudgeFor({ ...base, hrMethod: "healthkit" })).toBeNull();
    expect(hrNudgeFor({ ...base, isAndroid: false, isIos: true, hrMethod: "healthconnect" })).toBeNull();
  });
});
