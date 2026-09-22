import { beforeEach, describe, it, expect } from "vitest";
import { GEO_DIAG_LOG_KEY, GEO_DIAG_LOG_MAX, RUN_DIAG_LOG_KEY, RUN_DIAG_LOG_MAX, GEO_DEBUG_KEY } from "../constants";
import { logTrack, getTrackLog, clearTrackLog, setGeoDebug, isGeoDebugEnabled } from "./trackLog";

beforeEach(() => { localStorage.clear(); setGeoDebug(false); });

describe("trackLog", () => {
  it("records nothing while disabled (normal runs pay nothing)", () => {
    logTrack("fix", { t: 1 });
    expect(getTrackLog()).toEqual([]);
    expect(isGeoDebugEnabled()).toBe(false);
  });

  it("appends events, newest-last, once enabled", () => {
    setGeoDebug(true);
    logTrack("start", { msg: "native" });
    logTrack("fix", { t: 123, acc: 5, sinceMs: 2000 });
    const log = getTrackLog();
    expect(log).toHaveLength(2);
    expect(log[0].kind).toBe("start");
    expect(log[1]).toMatchObject({ kind: "fix", t: 123, acc: 5, sinceMs: 2000 });
    expect(typeof log[1].at).toBe("number");
  });

  it("caps at GEO_DIAG_LOG_MAX and keeps the newest", () => {
    setGeoDebug(true);
    for (let i = 0; i < GEO_DIAG_LOG_MAX + 50; i++) logTrack("native-fix", { t: i });
    const log = getTrackLog();
    expect(log).toHaveLength(GEO_DIAG_LOG_MAX);
    expect(log[log.length - 1].t).toBe(GEO_DIAG_LOG_MAX + 49); // newest kept
    expect(log[0].t).toBe(50);                                 // oldest 50 dropped
  });

  it("a run's worth of fixes never evicts the rows that explain it", () => {
    // The bug this split exists for: one shared cap meant ~33 minutes of GPS
    // pushed out `start`, the journal arming and every hr-* row, so a long run
    // logged the stream that was working and dropped the one being diagnosed.
    setGeoDebug(true);
    logTrack("start", { msg: "native" });
    logTrack("hr-journal", { msg: "reset+arm" });
    for (let i = 0; i < GEO_DIAG_LOG_MAX + 50; i++) logTrack("native-fix", { t: i });
    logTrack("hr-save", { msg: "live=900 journal=40 merged=920 coverage=96%" });
    const log = getTrackLog();
    // The fix stream really did overflow its own cap ...
    expect(log.filter(e => e.kind === "native-fix")).toHaveLength(GEO_DIAG_LOG_MAX);
    // ... and took none of the explanatory rows with it.
    const kinds = log.map(e => e.kind);
    expect(kinds).toContain("start");
    expect(kinds).toContain("hr-journal");
    expect(kinds).toContain("hr-save");
  });

  it("keeps the two streams on one timeline, in the order written", () => {
    setGeoDebug(true);
    logTrack("start");
    logTrack("native-fix", { t: 1 });
    logTrack("hr-beat", { n: 15, bpm: 142 });
    logTrack("fix", { t: 1 });
    expect(getTrackLog().map(e => e.kind)).toEqual(["start", "native-fix", "hr-beat", "fix"]);
  });

  it("caps the event buffer too, so a long session cannot grow unbounded", () => {
    setGeoDebug(true);
    for (let i = 0; i < RUN_DIAG_LOG_MAX + 25; i++) logTrack("hr-beat", { n: i });
    const beats = getTrackLog().filter(e => e.kind === "hr-beat");
    expect(beats).toHaveLength(RUN_DIAG_LOG_MAX);
    expect(beats[beats.length - 1].n).toBe(RUN_DIAG_LOG_MAX + 24); // newest kept
  });

  it("reads a pre-split log, where every kind shared one buffer", () => {
    localStorage.setItem(GEO_DIAG_LOG_KEY, JSON.stringify([
      { at: 1, kind: "start" }, { at: 2, kind: "fix", t: 2 }, { at: 3, kind: "hr-save", msg: "old" },
    ]));
    expect(getTrackLog().map(e => e.kind)).toEqual(["start", "fix", "hr-save"]);
  });

  it("clear empties both buffers", () => {
    setGeoDebug(true);
    logTrack("fix", {});
    logTrack("hr-beat", {});
    clearTrackLog();
    expect(getTrackLog()).toEqual([]);
    expect(localStorage.getItem(RUN_DIAG_LOG_KEY)).toBeNull();
  });

  it("setGeoDebug persists / clears the reveal flag", () => {
    setGeoDebug(true);
    expect(localStorage.getItem(GEO_DEBUG_KEY)).toBe("1");
    setGeoDebug(false);
    expect(localStorage.getItem(GEO_DEBUG_KEY)).toBeNull();
  });

  it("clear empties the log", () => {
    setGeoDebug(true);
    logTrack("fix", {});
    clearTrackLog();
    expect(getTrackLog()).toEqual([]);
  });

  it("tolerates corrupt storage", () => {
    localStorage.setItem(GEO_DIAG_LOG_KEY, "not json");
    expect(getTrackLog()).toEqual([]);
  });
});
