import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { armShellReporting, verdictFor, type ShellDiagEvent } from "./shellLog";

const h = vi.hoisted(() => ({
  isAndroid: true,
  nativeEvents: [] as { at: number; kind: string; detail?: string }[],
  geoDebug: true,
  trackLog: [] as unknown[],
  insert: vi.fn(async () => ({ error: null })),
  getEvents: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  registerPlugin: () => ({
    getEvents: async () => { h.getEvents(); return { events: h.nativeEvents, device: "test" }; },
    clear: async () => {},
  }),
}));
vi.mock("../native", () => ({
  get isAndroid() { return h.isAndroid; },
  platform: "android",
  nativeBuildLabel: () => "1.14.0",
}));
vi.mock("../supabase", () => ({ supabase: { from: () => ({ insert: h.insert }) } }));
vi.mock("../db", () => ({ currentUserId: () => "u1" }));
vi.mock("../geo/trackLog", () => ({
  getTrackLog: () => h.trackLog,
  isGeoDebugEnabled: () => h.geoDebug,
}));

// The three shapes are the three competing explanations for a recorder that
// comes back frozen, and telling them apart is the only reason this log exists.
// The JS GPS log stops identically in all three.

const T = 1_700_000_000_000;
const ev = (kind: string, offsetSec: number, detail?: string): ShellDiagEvent =>
  ({ at: T + offsetSec * 1000, kind, ...(detail ? { detail } : {}) });

describe("verdictFor", () => {
  it("names an OS reclaim, and says recording carried on", () => {
    const verdict = verdictFor([
      ev("create", 0, "cold"), ev("foreground", 1), ev("background", 60),
      ev("renderer-gone", 120, "didCrash=false foreground=false avail=180MB low=true"),
    ]);
    expect(verdict).toContain("reclaimed by the OS");
    expect(verdict).toContain("60s after the app was backgrounded");
    expect(verdict).toContain("recording carried on natively");
    expect(verdict).toContain("low=true"); // the memory snapshot rides along
  });

  it("distinguishes a real renderer crash from a reclaim", () => {
    const verdict = verdictFor([
      ev("background", 0), ev("renderer-gone", 30, "didCrash=true foreground=false avail=900MB low=false"),
    ]);
    expect(verdict).toContain("CRASHED");
    expect(verdict).not.toContain("reclaimed by the OS");
  });

  it("calls a cold boot with no renderer-gone a killed process", () => {
    const verdict = verdictFor([
      ev("background", 0), ev("create", 200, "cold"),
    ]);
    expect(verdict).toContain("PROCESS was killed");
    expect(verdict).toContain("Recording stopped there");
  });

  it("says nothing died when the app merely came back", () => {
    const verdict = verdictFor([
      ev("background", 0), ev("foreground", 300),
    ]);
    expect(verdict).toContain("Nothing died");
  });

  it("reads only the most recent backgrounded stretch", () => {
    // An older reclaim must not be reported as what happened this time.
    const verdict = verdictFor([
      ev("background", 0), ev("renderer-gone", 10, "didCrash=false"), ev("create", 20, "cold"),
      ev("foreground", 21), ev("background", 100), ev("foreground", 400),
    ]);
    expect(verdict).toContain("Nothing died");
  });

  it("has something to say before anything has been backgrounded", () => {
    expect(verdictFor([ev("create", 0, "cold")])).toContain("No backgrounded stretch");
    expect(verdictFor([])).toContain("No backgrounded stretch");
  });

  // A `restored` create is an activity recreation — a rotation, a theme or
  // locale change — which happens routinely with the process perfectly alive.
  // Reporting it as a process kill is the loudest verdict this can give, handed
  // out for a non-event, and it would send the next investigation after a
  // recording loss that never happened.
  it("does not call an activity recreation a killed process", () => {
    const verdict = verdictFor([ev("background", 0), ev("create", 30, "restored")]);
    expect(verdict).toContain("ACTIVITY was recreated");
    expect(verdict).not.toContain("PROCESS was killed");
    expect(verdict).not.toContain("Recording stopped there");
    // Ambiguous by construction, so it must not claim the process survived either.
    expect(verdict).toContain("process death");
  });
});

describe("armShellReporting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.isAndroid = true;
    h.geoDebug = true;
    h.nativeEvents = [];
    h.trackLog = [];
    h.insert.mockClear();
    h.getEvents.mockClear();
    localStorage.clear();
  });
  afterEach(() => { vi.useRealTimers(); });

  const settle = async () => { await vi.advanceTimersByTimeAsync(0); };
  const minute = async () => { await vi.advanceTimersByTimeAsync(60_000); };

  // The bug: the dedupe watermark was skipped whenever the native log was empty
  // (`newest && …`), which is the permanent state off Android and the state
  // after the panel's Clear. `fileShellReport` still filed on a non-empty GPS
  // track, and `writeLastFiled(0)` never moved the watermark — so an iOS or web
  // user who turned the developer log on inserted a row every 60 seconds, for as
  // long as the app stayed open.
  it("does not file on a loop when there is no native log to dedupe on", async () => {
    h.isAndroid = false;          // iOS or web: readShellLog always returns []
    h.trackLog = [{ at: 1, kind: "fix" }]; // …but the GPS log has content
    const disarm = armShellReporting();
    await settle();
    for (let i = 0; i < 5; i++) await minute();
    disarm();
    expect(h.insert).not.toHaveBeenCalled();
  });

  // Non-vacuity: the guard above must not have switched automatic filing off.
  it("still files once when a native event has landed, and not again", async () => {
    h.nativeEvents = [{ at: 1_700_000_000_000, kind: "background", detail: "saver=false" }];
    const disarm = armShellReporting();
    await settle();
    expect(h.insert).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) await minute();
    expect(h.insert).toHaveBeenCalledTimes(1); // nothing new happened natively
    h.nativeEvents = [...h.nativeEvents, { at: 1_700_000_060_000, kind: "foreground" }];
    await minute();
    expect(h.insert).toHaveBeenCalledTimes(2);
    disarm();
  });

  // The developer-log flag has to be read before the bridge call, not after:
  // `readShellLog` is IPC into the shell, and it was running on every Android
  // install every 60s regardless of the flag.
  it("makes no bridge call at all while the developer log is off", async () => {
    h.geoDebug = false;
    h.nativeEvents = [{ at: 1_700_000_000_000, kind: "background" }];
    const disarm = armShellReporting();
    await settle();
    await minute();
    disarm();
    expect(h.getEvents).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("does make the bridge call once the log is on", async () => {
    h.nativeEvents = [{ at: 1_700_000_000_000, kind: "background" }];
    const disarm = armShellReporting();
    await settle();
    disarm();
    expect(h.getEvents).toHaveBeenCalled();
  });
});
