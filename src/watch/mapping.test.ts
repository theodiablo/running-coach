import { describe, it, expect } from "vitest";
import { sessionRunType, sessionLocalDate, sessionToRun, newWatchSessions } from "./mapping";
import type { WatchSessionRaw } from "./plugin";
import type { Run } from "../types";

const session = (over: Partial<WatchSessionRaw> = {}): WatchSessionRaw => ({
  id: "s1",
  startTime: "2026-07-10T08:00:00Z",
  endTime: "2026-07-10T08:45:00Z",
  exerciseType: 56,
  distanceM: 8000,
  ...over,
});

describe("sessionRunType", () => {
  it("maps running/treadmill to EASY and walking/hiking to WALK", () => {
    expect(sessionRunType(56)).toBe("EASY");
    expect(sessionRunType(57)).toBe("EASY");
    expect(sessionRunType(79)).toBe("WALK");
    expect(sessionRunType(37)).toBe("WALK");
  });
  it("returns null for non-run activities and undefined", () => {
    expect(sessionRunType(8)).toBeNull();   // biking
    expect(sessionRunType(undefined)).toBeNull();
  });
});

describe("sessionLocalDate", () => {
  it("uses the session zone offset so a late-night run lands on the local day", () => {
    // 23:30 UTC is already the next day in UTC+10.
    expect(sessionLocalDate("2026-07-10T23:30:00Z", 10 * 3600)).toBe("2026-07-11");
  });
  it("respects a negative offset", () => {
    // 01:00 UTC is still the previous day in UTC-5.
    expect(sessionLocalDate("2026-07-11T01:00:00Z", -5 * 3600)).toBe("2026-07-10");
  });
  it("returns empty for an unparseable instant", () => {
    expect(sessionLocalDate("not-a-date", 0)).toBe("");
  });
});

describe("sessionToRun", () => {
  it("maps metres/seconds/bpm into the run shape", () => {
    const r = sessionToRun(session({ distanceM: 8230, activeSec: 2600, hrAvg: 148.4, hrMax: 171, elevationGainM: 82.6, startZoneOffsetSec: 0 }));
    expect(r).toMatchObject({
      date: "2026-07-10", type: "EASY", km: 8.23, durationSec: 2600,
      // Nobody was asked how it felt, so nothing is claimed — an imported run
      // used to assert a middle effort the coach then read as a real answer.
      hr: 148, hrMax: 171, elevation: 83, effort: null, source: "watch",
      hcId: "s1", startedAt: "2026-07-10T08:00:00Z",
    });
  });
  it("falls back to elapsed time when active duration is absent or zero", () => {
    expect(sessionToRun(session({ activeSec: null })).durationSec).toBe(45 * 60); // 08:00 → 08:45
    // A 0 aggregate must not produce a zero-second run (infinite pace).
    expect(sessionToRun(session({ activeSec: 0 })).durationSec).toBe(45 * 60);
  });
  it("omits elevation and nulls HR when the watch didn't record them", () => {
    const r = sessionToRun(session({ elevationGainM: null, hrAvg: null, hrMax: null }));
    expect(r.elevation).toBeUndefined();
    expect(r.hr).toBeNull();
    expect(r.hrMax).toBeNull();
  });
  it("maps a walk type", () => {
    expect(sessionToRun(session({ exerciseType: 79 })).type).toBe("WALK");
  });
  it("stamps the writing app's brand into the notes", () => {
    expect(sessionToRun(session({ dataOrigin: "com.garmin.android.apps.connectmobile" })).notes).toBe("Imported from Garmin");
    expect(sessionToRun(session({ dataOrigin: "com.huami.watch.hmwatchmanager" })).notes).toBe("Imported from Zepp");
    expect(sessionToRun(session()).notes).toBe("Imported from your watch");
  });
});

// Dedupe is the shared isDuplicateRun (src/imports/dedupe.ts — unit-tested in
// src/imports/registry.test.ts); these cover its application at the watch level:
// sessions are mapped first, then deduped once on the run shape.
describe("newWatchSessions", () => {
  const runs = (over: Partial<Run>[] = []): Run[] => over.map((o, i) => ({ id: "r" + i, date: "2026-07-10", km: 8, ...o }));

  it("keeps only runnable, non-duplicate sessions and maps them", () => {
    const sessions = [
      session({ id: "run", exerciseType: 56 }),
      session({ id: "bike", exerciseType: 8 }),         // dropped: not a run
      session({ id: "seen", exerciseType: 56 }),         // dropped: seen
    ];
    const out = newWatchSessions(sessions, [], ["seen"]);
    expect(out).toHaveLength(1);
    expect(out[0].hcId).toBe("run");
  });
  it("drops a session already logged (hcId, time overlap, or fuzzy manual match)", () => {
    expect(newWatchSessions([session()], runs([{ hcId: "s1" }]), [])).toHaveLength(0);
    expect(newWatchSessions([session()], runs([{ startedAt: "2026-07-10T08:10:00Z", durationSec: 3000 }]), [])).toHaveLength(0);
    expect(newWatchSessions([session()], runs([{ km: 8.5 }]), [])).toHaveLength(0); // manual log, no startedAt
  });
  it("keeps a session that overlaps nothing and fuzzy-matches nothing", () => {
    const existing = runs([{ startedAt: "2026-07-10T06:00:00Z", durationSec: 600 }, { km: 12 }, { date: "2026-07-09", km: 8 }]);
    expect(newWatchSessions([session()], existing, [])).toHaveLength(1);
  });
  it("dedupes within the batch itself (same run reported twice)", () => {
    const out = newWatchSessions([session({ id: "a" }), session({ id: "b" })], [], []); // identical windows
    expect(out).toHaveLength(1);
  });
});
