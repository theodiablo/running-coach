import { beforeEach, describe, it, expect, vi } from "vitest";
import { isDuplicateRun } from "./dedupe";
import { dataOriginLabel, importedNote } from "./dataOrigin";
import { fileProvider } from "./providers/file";
import { makeCloudProvider } from "./providers/cloud";
import type { ImportedRun } from "./types";

// Swap the two scan-capable registry entries for controllable fakes so the REAL
// scanAllProviders merge/dedupe pass is what's under test. vi.hoisted because
// vi.mock factories run before module-level consts are initialised.
const { hcScan, hcAvailable, cloudScan, cloudAvailable } = vi.hoisted(() => ({
  hcScan: vi.fn(async (): Promise<unknown[]> => []),
  hcAvailable: vi.fn(() => true),
  cloudScan: vi.fn(async (): Promise<unknown[]> => []),
  cloudAvailable: vi.fn(() => true),
}));
vi.mock("./providers/healthConnect", () => ({
  healthConnectProvider: {
    id: "healthconnect", label: "HC", kind: "healthconnect", platform: "native",
    isAvailable: () => hcAvailable(), scan: (...a: unknown[]) => hcScan(...(a as [])),
  },
}));
vi.mock("./providers/cloud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./providers/cloud")>()),
  garminCloudProvider: {
    id: "garmin", label: "Garmin", kind: "cloud", platform: "both",
    isAvailable: () => cloudAvailable(), scan: (...a: unknown[]) => cloudScan(...(a as [])),
  },
}));

import { scanAllProviders, scanSourceId } from "./registry";

beforeEach(() => {
  localStorage.clear();
  hcScan.mockReset().mockResolvedValue([]);
  cloudScan.mockReset().mockResolvedValue([]);
  hcAvailable.mockReset().mockReturnValue(true);
  cloudAvailable.mockReset().mockReturnValue(true);
});

describe("isDuplicateRun", () => {
  const cand: ImportedRun = { date: "2026-07-10", km: 8, durationSec: 2400, hcId: "a", startedAt: "2026-07-10T08:00:00Z" };

  it("matches hcId in seen ids and on existing runs", () => {
    expect(isDuplicateRun(cand, [], ["a"])).toBe(true);
    expect(isDuplicateRun(cand, [{ hcId: "a" }], [])).toBe(true);
  });
  it("matches extId on existing runs (cloud id-space)", () => {
    expect(isDuplicateRun({ ...cand, hcId: undefined, extId: "g1" }, [{ extId: "g1" }], [])).toBe(true);
  });
  it("matches overlapping time windows", () => {
    expect(isDuplicateRun(cand, [{ startedAt: "2026-07-10T08:20:00Z", durationSec: 1800 }], [])).toBe(true);
    expect(isDuplicateRun(cand, [{ startedAt: "2026-07-10T10:00:00Z", durationSec: 1800 }], [])).toBe(false);
  });
  it("fuzzy-matches same date within 10% distance when either side lacks a window", () => {
    expect(isDuplicateRun(cand, [{ date: "2026-07-10", km: 8.4 }], [])).toBe(true);
    expect(isDuplicateRun(cand, [{ date: "2026-07-10", km: 12 }], [])).toBe(false);
    expect(isDuplicateRun(cand, [{ date: "2026-07-09", km: 8 }], [])).toBe(false);
  });
  it("skips the fuzzy fallback with {fuzzy:false} (file imports must not drop same-day doubles)", () => {
    expect(isDuplicateRun(cand, [{ date: "2026-07-10", km: 8.4 }], [], { fuzzy: false })).toBe(false);
    // Strong signals still dedupe: same id, and real time overlap.
    expect(isDuplicateRun(cand, [{ hcId: "a" }], [], { fuzzy: false })).toBe(true);
    expect(isDuplicateRun(cand, [{ startedAt: "2026-07-10T08:20:00Z", durationSec: 1800 }], [], { fuzzy: false })).toBe(true);
  });
});

describe("scanAllProviders", () => {
  const runA: ImportedRun = { date: "2026-07-10", km: 8, durationSec: 2400, startedAt: "2026-07-10T08:00:00Z", hcId: "a" };

  it("merges providers and collapses the same run arriving from two sources", async () => {
    hcScan.mockResolvedValue([runA]);
    // Same time window from the cloud source, its own id-space.
    cloudScan.mockResolvedValue([{ ...runA, hcId: undefined, extId: "g1" }]);
    const out = await scanAllProviders([]);
    expect(out).toHaveLength(1);
    expect(out[0].hcId).toBe("a");
  });

  it("keeps genuinely different runs from different providers", async () => {
    hcScan.mockResolvedValue([runA]);
    cloudScan.mockResolvedValue([{ date: "2026-07-08", km: 12, durationSec: 3600, startedAt: "2026-07-08T07:00:00Z", extId: "g2" }]);
    expect(await scanAllProviders([])).toHaveLength(2);
  });

  it("skips unavailable providers and honours the enabled predicate", async () => {
    hcScan.mockResolvedValue([runA]);
    cloudAvailable.mockReturnValue(false);
    expect(await scanAllProviders([], { enabled: p => p.id !== "healthconnect" })).toHaveLength(0);
    expect(cloudScan).not.toHaveBeenCalled();
    expect(hcScan).not.toHaveBeenCalled();
  });

  it("dedupes against seen ids and never throws on a failing provider", async () => {
    localStorage.setItem("rc_watch_seen_hc_ids", JSON.stringify(["a"]));
    hcScan.mockResolvedValue([runA]);
    cloudScan.mockRejectedValue(new Error("boom"));
    expect(await scanAllProviders([])).toHaveLength(0);
  });

  // The import toast names the integration that delivered the runs, and only
  // the registry knows which scan produced each one — deriving it downstream
  // would mean re-reading id prefixes off the run.
  it("stamps each candidate with the provider that produced it", async () => {
    hcScan.mockResolvedValue([runA]);
    cloudScan.mockResolvedValue([{ date: "2026-07-08", km: 12, durationSec: 3600, startedAt: "2026-07-08T07:00:00Z", extId: "g2" }]);
    const out = await scanAllProviders([]);
    expect(out.map(r => r.providerId)).toEqual(["healthconnect", "garmin"]);
  });
});

describe("scanSourceId", () => {
  it("names a single source and stays silent about a merged scan", () => {
    expect(scanSourceId([{ providerId: "suunto" }, { providerId: "suunto" }])).toBe("suunto");
    // Two sources in one pass: naming either one would be wrong.
    expect(scanSourceId([{ providerId: "suunto" }, { providerId: "healthconnect" }])).toBeNull();
    expect(scanSourceId([{ km: 5 }])).toBeNull();
    expect(scanSourceId([])).toBeNull();
  });
});

describe("dataOrigin", () => {
  it("labels known packages and falls back generically", () => {
    expect(dataOriginLabel("com.garmin.android.apps.connectmobile")).toBe("Garmin");
    expect(dataOriginLabel("com.huami.watch.hmwatchmanager")).toBe("Zepp");
    expect(dataOriginLabel("com.example.unknown")).toBe("your watch");
    expect(importedNote("com.garmin.android.apps.connectmobile")).toBe("Imported from Garmin");
  });
});

describe("fileProvider.parse", () => {
  it("routes by extension and rejects unknown types", () => {
    expect(fileProvider.parse!({ name: "x.docx", text: "" }).error).toMatch(/Unsupported/);
    // CSV path still works (Zepp headers), byte-for-byte the old flow.
    const csv = "Start Time,Distance (m),Duration (s),Average Heart Rate (bpm),Max Heart Rate (bpm)\n2026-07-01 08:00,8000,2400,150,170";
    const res = fileProvider.parse!({ name: "zepp.csv", text: csv });
    expect(res.error).toBeNull();
    expect(res.runs).toHaveLength(1);
    expect(res.runs[0].km).toBe(8);
  });
});

describe("cloud scaffold", () => {
  it("is invisible and inert until configured", async () => {
    const p = makeCloudProvider({ id: "x", label: "X" });
    expect(await p.isAvailable()).toBe(false);
    expect(await p.connect!()).toBe(false);
    expect(await p.scan!([])).toEqual([]);
  });
  it("activates only with a clientId", async () => {
    const p = makeCloudProvider({ id: "x", label: "X", clientId: "abc", scan: async () => [{ km: 5, date: "2026-07-10" }] });
    expect(await p.isAvailable()).toBe(true);
    expect(await p.scan!([])).toHaveLength(1);
  });
});

describe("suunto registration", () => {
  it("is registered but dormant without VITE_SUUNTO_CLIENT_ID", async () => {
    const { getProvider } = await import("./registry");
    const p = getProvider("suunto");
    expect(p).toBeTruthy();
    expect(p!.kind).toBe("cloud");
    expect(await p!.isAvailable()).toBe(false); // no env in tests → invisible, scans skip it
  });
});
