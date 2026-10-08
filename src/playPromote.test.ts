import { describe, it, expect } from "vitest";
// @ts-expect-error Build script ESM has no TypeScript declaration file.
import * as promote from "../scripts/play-promote.mjs";

interface Release { name?: string; versionCodes: string[]; status: string; userFraction?: number; releaseNotes?: unknown[] }
interface Track { track: string; releases: Release[] }
const { pickRelease, promotedReleases } = promote as {
  pickRelease: (t: Track, code?: string) => Release;
  promotedReleases: (r: Release, t: Track, o?: { rolloutPercent?: number | string; draft?: boolean }) => Release[];
};

const notes = [{ language: "en-US", text: "Fixes" }];
const internal: Track = {
  track: "internal",
  releases: [
    { name: "1.4.0", versionCodes: ["1001045001"], status: "completed" },
    { name: "1.5.0", versionCodes: ["1001052002"], status: "completed", releaseNotes: notes },
    { name: "1.6.0", versionCodes: ["1001060001"], status: "draft" },
  ],
};
const production: Track = { track: "production", releases: [{ name: "1.3.0", versionCodes: ["1001030001"], status: "completed" }] };

describe("pickRelease", () => {
  it("defaults to the newest completed release, never a draft", () => {
    expect(pickRelease(internal).name).toBe("1.5.0");
  });
  it("finds an explicit versionCode and refuses one the track doesn't carry", () => {
    expect(pickRelease(internal, "1001045001").name).toBe("1.4.0");
    expect(() => pickRelease(internal, "42")).toThrow(/not on the internal track/);
  });
  it("refuses a track with nothing completed", () => {
    expect(() => pickRelease({ track: "internal", releases: [] })).toThrow(/No completed release/);
  });
});

describe("promotedReleases", () => {
  const rel = pickRelease(internal);
  it("a full rollout replaces the target's releases and carries the notes", () => {
    expect(promotedReleases(rel, production)).toEqual([
      { name: "1.5.0", versionCodes: ["1001052002"], status: "completed", releaseNotes: notes },
    ]);
  });
  it("a staged rollout keeps the live release for everyone else", () => {
    const out = promotedReleases(rel, production, { rolloutPercent: "20" });
    expect(out[0]).toBe(production.releases[0]);
    expect(out[1]).toMatchObject({ status: "inProgress", userFraction: 0.2 });
  });
  it("widening a rollout doesn't keep the same build twice", () => {
    const staged: Track = { track: "production", releases: [...production.releases, { ...rel, status: "inProgress", userFraction: 0.2 }] };
    const out = promotedReleases(rel, staged, { rolloutPercent: 50 });
    expect(out.map((r) => r.status)).toEqual(["completed", "inProgress"]);
    expect(out[0].name).toBe("1.3.0");
  });
  it("draft and bad percentages", () => {
    expect(promotedReleases(rel, production, { draft: true })[0].status).toBe("draft");
    expect(() => promotedReleases(rel, production, { rolloutPercent: 0 })).toThrow();
    expect(() => promotedReleases(rel, production, { rolloutPercent: "abc" })).toThrow();
  });
});
