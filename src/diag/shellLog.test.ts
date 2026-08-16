import { describe, expect, it, vi } from "vitest";
import { verdictFor, type ShellDiagEvent } from "./shellLog";

vi.mock("@capacitor/core", () => ({ registerPlugin: () => ({}) }));
vi.mock("../native", () => ({ isAndroid: true }));

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
});
