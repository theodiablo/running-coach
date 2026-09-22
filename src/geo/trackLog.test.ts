import { beforeEach, describe, it, expect, vi } from "vitest";
import { GEO_DIAG_LOG_KEY, GEO_DIAG_LOG_MAX, RUN_DIAG_LOG_KEY, RUN_DIAG_LOG_MAX, DIAG_LOG_HEAD, GEO_DEBUG_KEY } from "../constants";
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
    expect(log[0].t).toBe(0);                                  // head kept, middle dropped
    expect(log[DIAG_LOG_HEAD].t).toBe(100);
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

  it("survives a reconnect storm without losing the run it explains", () => {
    // The event cap has to be sized against the WORST session, not the healthy
    // one: a dropout that degenerates into a reconnect storm writes ~7 rows per
    // RETRY_MAX_MS cycle (~1500/h), and that storm is the log worth reading.
    setGeoDebug(true);
    logTrack("start", { msg: "native" });
    logTrack("hr-journal", { msg: "reset+arm" });
    for (let i = 0; i < RUN_DIAG_LOG_MAX + 50; i++)
      logTrack("hr-connect", { ok: false, msg: "disconnected by peer", n: i });
    const log = getTrackLog();
    const kinds = log.map(e => e.kind);
    expect(kinds).toContain("start");      // when the storm began ...
    expect(kinds).toContain("hr-journal");
    expect(log[log.length - 1].n).toBe(RUN_DIAG_LOG_MAX + 49);   // ... and where it got to
    expect(log).toHaveLength(RUN_DIAG_LOG_MAX);
  });

  it("merges on write order, not the wall clock", async () => {
    // A phone's clock can step BACKWARDS mid-run (an NTP correction). Sorting
    // the two buffers by `at` would put the stall ahead of the start of the run
    // it belongs to.
    setGeoDebug(true);
    const real = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now;
    try {
      logTrack("start");
      now += 1000; logTrack("native-fix", { t: 1 });
      now -= 3000; logTrack("hr-stall", { msg: "link-dead" });
      now += 500;  logTrack("native-fix", { t: 2 });
    } finally { Date.now = real; }
    expect(getTrackLog().map(e => e.kind))
      .toEqual(["start", "native-fix", "hr-stall", "native-fix"]);
  });

  it("keeps write order across an app restart, when seq restarts from zero", async () => {
    setGeoDebug(true);
    logTrack("start");
    logTrack("native-fix", { t: 1 });
    logTrack("hr-beat", { n: 1 });
    vi.resetModules();
    const fresh = await import("./trackLog");
    fresh.setGeoDebug(true);
    fresh.logTrack("native-fix", { t: 2 });
    fresh.logTrack("hr-save", { msg: "coverage=96%" });
    expect(fresh.getTrackLog().map(e => e.kind))
      .toEqual(["start", "native-fix", "hr-beat", "native-fix", "hr-save"]);
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
