import { describe, it, expect } from "vitest";
// @ts-expect-error Build script ESM has no TypeScript declaration file.
import * as promote from "../scripts/asc-promote.mjs";

interface Build {
  id: string; build: string; version?: string; uploadedDate: string; processingState: string; expired: boolean;
  internalBuildState?: string; externalBuildState?: string; groupIds?: string[];
}
interface Group { id: string; name: string; isInternalGroup: boolean }
interface Version { id: string; versionString: string; appStoreState?: string; appVersionState?: string; buildId?: string }
const { normalizeBuilds, buildReadiness, pickBuild, pickGroups, planAppStoreVersion, pickSubmission, hasReleased, notesFromInput } = promote as {
  normalizeBuilds: (page: unknown) => Build[];
  buildReadiness: (b: Build, target: string) => "wait" | "ready";
  pickSubmission: (s: { id: string; attributes: { state: string } }[]) => { id: string } | undefined;
  pickBuild: (b: Build[], o?: { version?: string; build?: string }) => Build | undefined;
  pickGroups: (g: Group[], names?: string) => Group[];
  planAppStoreVersion: (v: Version[], s: string, buildId: string) => { action: string; version?: Version };
  hasReleased: (v: Version[]) => boolean;
  notesFromInput: (t?: string) => string | undefined;
};

describe("normalizeBuilds", () => {
  it("reads the version, beta states and groups off the included resources", () => {
    const page = {
      data: [{
        id: "b1",
        attributes: { version: "52001", uploadedDate: "2026-10-01T10:00:00Z", processingState: "VALID", expired: false },
        relationships: {
          preReleaseVersion: { data: { type: "preReleaseVersions", id: "p1" } },
          buildBetaDetail: { data: { type: "buildBetaDetails", id: "d1" } },
          betaGroups: { data: [{ type: "betaGroups", id: "g2" }] },
        },
      }],
      included: [
        { type: "preReleaseVersions", id: "p1", attributes: { version: "1.5.0", platform: "IOS" } },
        { type: "buildBetaDetails", id: "d1", attributes: { internalBuildState: "IN_BETA_TESTING", externalBuildState: "READY_FOR_BETA_SUBMISSION" } },
      ],
    };
    expect(normalizeBuilds(page)).toEqual([{
      id: "b1", build: "52001", version: "1.5.0", uploadedDate: "2026-10-01T10:00:00Z", processingState: "VALID", expired: false,
      internalBuildState: "IN_BETA_TESTING", externalBuildState: "READY_FOR_BETA_SUBMISSION", groupIds: ["g2"],
    }]);
  });
});

describe("buildReadiness", () => {
  const base: Build = { id: "b", build: "1", version: "1.5.0", uploadedDate: "", processingState: "VALID", expired: false };
  it("waits on the binary, then on TestFlight's own pass for testflight only", () => {
    expect(buildReadiness({ ...base, processingState: "PROCESSING" }, "production")).toBe("wait");
    const beta = { ...base, internalBuildState: "IN_BETA_TESTING", externalBuildState: "PROCESSING" };
    expect(buildReadiness(beta, "testflight")).toBe("wait");
    expect(buildReadiness(beta, "production")).toBe("ready");
    expect(buildReadiness({ ...beta, externalBuildState: "READY_FOR_BETA_SUBMISSION" }, "testflight")).toBe("ready");
  });
  it("stops on a build Apple refused", () => {
    expect(() => buildReadiness({ ...base, processingState: "INVALID" }, "production")).toThrow(/INVALID/);
    expect(() => buildReadiness({ ...base, externalBuildState: "PROCESSING_EXCEPTION" }, "testflight")).toThrow(/TestFlight processing failed/);
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
  it("resumes a submission that was prepared but never sent", () => {
    const pending: Version = { id: "v2", versionString: "1.5.0", appVersionState: "READY_FOR_REVIEW", buildId: "b" };
    expect(planAppStoreVersion([live, pending], "1.5.0", "b")).toMatchObject({ action: "resume", version: pending });
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

describe("pickSubmission", () => {
  it("reuses an unsent submission and refuses one already in progress", () => {
    expect(pickSubmission([])).toBeUndefined();
    expect(pickSubmission([{ id: "s1", attributes: { state: "READY_FOR_REVIEW" } }])?.id).toBe("s1");
    expect(() => pickSubmission([{ id: "s2", attributes: { state: "UNRESOLVED_ISSUES" } }])).toThrow(/already UNRESOLVED_ISSUES/);
  });
});

describe("notesFromInput", () => {
  it("turns | into line breaks and caps the length", () => {
    expect(notesFromInput(" Faster GPS | Fixes ")).toBe("Faster GPS\nFixes");
    expect(notesFromInput("a\\nb")).toBe("a\nb");
    expect(notesFromInput("  ")).toBeUndefined();
    expect(() => notesFromInput("x".repeat(4001))).toThrow(/4000/);
  });
});
