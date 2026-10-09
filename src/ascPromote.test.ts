import { describe, it, expect } from "vitest";
// @ts-expect-error Build script ESM has no TypeScript declaration file.
import * as promote from "../scripts/asc-promote.mjs";

interface Build { id: string; build: string; version?: string; uploadedDate: string; processingState: string; expired: boolean }
interface Group { id: string; name: string; isInternalGroup: boolean }
interface Version { id: string; versionString: string; appStoreState?: string; appVersionState?: string; buildId?: string }
const { normalizeBuilds, pickBuild, pickGroups, planAppStoreVersion, hasReleased, notesFromInput } = promote as {
  normalizeBuilds: (page: unknown) => Build[];
  pickBuild: (b: Build[], o?: { version?: string; build?: string }) => Build | undefined;
  pickGroups: (g: Group[], names?: string) => Group[];
  planAppStoreVersion: (v: Version[], s: string, buildId: string) => { action: string; version?: Version };
  hasReleased: (v: Version[]) => boolean;
  notesFromInput: (t?: string) => string | undefined;
};

describe("normalizeBuilds", () => {
  it("reads the marketing version off the included preReleaseVersion", () => {
    const page = {
      data: [{
        id: "b1",
        attributes: { version: "52001", uploadedDate: "2026-10-01T10:00:00Z", processingState: "VALID", expired: false },
        relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "p1" } } },
      }],
      included: [{ type: "preReleaseVersions", id: "p1", attributes: { version: "1.5.0", platform: "IOS" } }],
    };
    expect(normalizeBuilds(page)).toEqual([
      { id: "b1", build: "52001", version: "1.5.0", uploadedDate: "2026-10-01T10:00:00Z", processingState: "VALID", expired: false },
    ]);
  });
});

describe("pickBuild", () => {
  const builds: Build[] = [
    { id: "a", build: "45001", version: "1.4.0", uploadedDate: "2026-09-01T00:00:00Z", processingState: "VALID", expired: false },
    { id: "b", build: "52001", version: "1.5.0", uploadedDate: "2026-10-01T00:00:00Z", processingState: "VALID", expired: false },
    { id: "c", build: "52002", version: "1.5.0", uploadedDate: "2026-10-02T00:00:00Z", processingState: "PROCESSING", expired: false },
    { id: "d", build: "60001", version: "1.6.0", uploadedDate: "2026-10-05T00:00:00Z", processingState: "VALID", expired: true },
  ];
  it("defaults to the newest unexpired upload, even while it processes", () => {
    expect(pickBuild(builds)?.id).toBe("c");
  });
  it("narrows by version and build number", () => {
    expect(pickBuild(builds, { version: "1.4.0" })?.id).toBe("a");
    expect(pickBuild(builds, { version: "1.5.0", build: "52001" })?.id).toBe("b");
  });
  it("returns nothing for a build that isn't there yet", () => {
    expect(pickBuild(builds, { version: "1.7.0" })).toBeUndefined();
    expect(pickBuild(builds, { version: "1.6.0" })).toBeUndefined();
  });
});

describe("pickGroups", () => {
  const groups: Group[] = [
    { id: "1", name: "Team", isInternalGroup: true },
    { id: "2", name: "Beta runners", isInternalGroup: false },
    { id: "3", name: "Friends", isInternalGroup: false },
  ];
  it("defaults to every external group", () => {
    expect(pickGroups(groups).map((g) => g.id)).toEqual(["2", "3"]);
    expect(() => pickGroups(groups.slice(0, 1))).toThrow(/No external TestFlight group/);
  });
  it("matches names case-insensitively and refuses unknown ones", () => {
    expect(pickGroups(groups, " team, beta RUNNERS ").map((g) => g.id)).toEqual(["1", "2"]);
    expect(() => pickGroups(groups, "Nope")).toThrow(/No TestFlight group named 'Nope'/);
  });
});

describe("planAppStoreVersion", () => {
  const live: Version = { id: "v1", versionString: "1.4.0", appStoreState: "READY_FOR_SALE" };
  it("creates a version when only released ones exist", () => {
    expect(planAppStoreVersion([live], "1.5.0", "b")).toEqual({ action: "create" });
  });
  it("reuses an editable version of the same string, renames a different one", () => {
    const prep: Version = { id: "v2", versionString: "1.5.0", appVersionState: "PREPARE_FOR_SUBMISSION" };
    expect(planAppStoreVersion([live, prep], "1.5.0", "b")).toMatchObject({ action: "reuse", version: prep });
    expect(planAppStoreVersion([live, prep], "1.5.1", "b")).toMatchObject({ action: "rename", version: prep });
  });
  it("is a no-op for a re-run once this build is in review", () => {
    const waiting: Version = { id: "v2", versionString: "1.5.0", appStoreState: "WAITING_FOR_REVIEW", buildId: "b" };
    expect(planAppStoreVersion([live, waiting], "1.5.0", "b").action).toBe("submitted");
  });
  it("refuses while another version is in flight or the string already shipped", () => {
    const review: Version = { id: "v2", versionString: "1.5.0", appStoreState: "IN_REVIEW", buildId: "x" };
    expect(() => planAppStoreVersion([live, review], "1.5.1", "b")).toThrow(/1\.5\.0 is IN_REVIEW/);
    expect(() => planAppStoreVersion([live, review], "1.5.0", "b")).toThrow(/already IN_REVIEW/);
    expect(() => planAppStoreVersion([live], "1.4.0", "b")).toThrow(/already READY_FOR_SALE/);
  });
  it("knows whether the app ever shipped", () => {
    expect(hasReleased([live])).toBe(true);
    expect(hasReleased([{ id: "v", versionString: "1.0.0", appStoreState: "PREPARE_FOR_SUBMISSION" }])).toBe(false);
  });
});

describe("notesFromInput", () => {
  it("turns | into line breaks and caps the length", () => {
    expect(notesFromInput(" Faster GPS | Fixes ")).toBe("Faster GPS\nFixes");
    expect(notesFromInput("  ")).toBeUndefined();
    expect(() => notesFromInput("x".repeat(4001))).toThrow(/4000/);
  });
});
