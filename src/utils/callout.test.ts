import { describe, it, expect } from "vitest";
import { CALLOUT_MIN_INTO_STEP_SEC, DEFAULT_AUDIO, HR_WARN_EVERY_SEC, calloutContent, calloutDue, hrWarnDue, readAudioPrefs } from "./callout";
import type { WorkoutStep } from "./workout";

describe("readAudioPrefs", () => {
  it("defaults to 60 s callouts, ±10 s, warn above zone", () => {
    expect(readAudioPrefs(undefined)).toEqual(DEFAULT_AUDIO);
    expect(DEFAULT_AUDIO).toMatchObject({ freq: 60, band: 10, hrWarn: 0, freeOn: false });
  });

  it("drops values the sheet can't produce", () => {
    expect(readAudioPrefs({ freq: 45, band: 100, hrWarn: 3, say: { pace: "yes" }, freeOn: 1 })).toEqual(DEFAULT_AUDIO);
  });

  it("keeps a valid blob", () => {
    const p = { freq: "km", band: 20, hrWarn: "off", say: { pace: false, hr: true, dist: true, left: false }, freeOn: true };
    expect(readAudioPrefs(p)).toEqual(p);
  });
});

describe("calloutDue", () => {
  const clock = { lastAtSec: 100, lastKm: 3 };

  it("fires on the moving-time interval", () => {
    expect(calloutDue(60, { movingSec: 159, km: 3.5, stepElapsedSec: 200 }, clock)).toBe(false);
    expect(calloutDue(60, { movingSec: 160, km: 3.5, stepElapsedSec: 200 }, clock)).toBe(true);
  });

  it("waits for pace to settle after a step change", () => {
    expect(calloutDue(30, { movingSec: 200, km: 3.5, stepElapsedSec: CALLOUT_MIN_INTO_STEP_SEC - 1 }, clock)).toBe(false);
  });

  it("per km: on each whole kilometre crossed", () => {
    expect(calloutDue("km", { movingSec: 101, km: 3.99, stepElapsedSec: 0 }, clock)).toBe(false);
    expect(calloutDue("km", { movingSec: 101, km: 4.01, stepElapsedSec: 0 }, clock)).toBe(true);
  });
});

describe("hrWarnDue", () => {
  const step: WorkoutStep = { kind: "work", hrLo: 150, hrHi: 170 };

  it("warns above the zone top by the margin", () => {
    expect(hrWarnDue(step, 0, 171, 500, -Infinity)).toBe(true);
    expect(hrWarnDue(step, 5, 174, 500, -Infinity)).toBe(false);
    expect(hrWarnDue(step, 5, 176, 500, -Infinity)).toBe(true);
  });

  it("never when off, without a reading, without a target, or too soon", () => {
    expect(hrWarnDue(step, "off", 190, 500, -Infinity)).toBe(false);
    expect(hrWarnDue(step, 0, null, 500, -Infinity)).toBe(false);
    expect(hrWarnDue({ kind: "recover", sec: 90 }, 0, 190, 500, -Infinity)).toBe(false);
    expect(hrWarnDue(step, 0, 190, 500, 500 - HR_WARN_EVERY_SEC + 1)).toBe(false);
  });
});

describe("calloutContent", () => {
  const step: WorkoutStep = { kind: "work", m: 1000, pace: 300, band: 10 };
  const now = { km: 4.2, curPace: 315, hr: 160, left: { m: 400 } };

  it("says what the runner picked", () => {
    expect(calloutContent({ pace: true, hr: true, dist: false, left: true }, step, now, false))
      .toEqual({ km: null, verdict: "slow", pace: 315, target: 300, hr: 160, left: { m: 400 } });
    expect(calloutContent({ pace: false, hr: false, dist: false, left: false }, step, now, false))
      .toEqual({ km: null, verdict: null, pace: null, target: 300, hr: null, left: null });
  });

  it("per-km callouts always name the distance", () => {
    expect(calloutContent({ pace: false, hr: false, dist: false, left: false }, step, now, true).km).toBe(4.2);
  });

  it("gives no verdict without a pace target or before there is a pace", () => {
    expect(calloutContent(DEFAULT_AUDIO.say, { kind: "steady" }, now, false).verdict).toBeNull();
    expect(calloutContent(DEFAULT_AUDIO.say, step, { ...now, curPace: 0 }, false).pace).toBeNull();
  });
});
