import { describe, it, expect } from "vitest";
import { polarExerciseToRun } from "./polar";

// A tiny GPX with HR extensions (≈1.11 km north, 10 min), same shape as gpx.test.
const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <trk><trkseg>
    <trkpt lat="45.000" lon="5.000"><ele>200</ele><time>2026-07-10T08:00:00Z</time>
      <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>140</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
    <trkpt lat="45.010" lon="5.000"><ele>210</ele><time>2026-07-10T08:10:00Z</time>
      <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>160</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
  </trkseg></trk>
</gpx>`;

describe("polarExerciseToRun", () => {
  it("imports a summary-only run (no GPX): distance, ISO duration, HR, extId", () => {
    const run = polarExerciseToRun({
      id: "abc",
      summary: {
        id: "abc",
        "start-time": "2026-07-10T08:00:00",
        duration: "PT1H2M3S",
        distance: 12000,
        "heart-rate": { average: 152.4, maximum: 178 },
        "detailed-sport-info": "RUNNING",
      },
    });
    expect(run).toMatchObject({
      date: "2026-07-10",
      type: "EASY",
      km: 12,
      durationSec: 3723,        // 1h2m3s
      hr: 152,
      hrMax: 178,
      source: "watch",
      notes: "Imported from Polar",
      extId: "polar:abc",
      startedAt: "2026-07-10T08:00:00",
    });
    expect(run!.points).toBeUndefined(); // summary-only → no route
  });

  it("maps a walking sport to WALK", () => {
    const run = polarExerciseToRun({
      id: "w1",
      summary: { id: "w1", "start-time": "2026-07-10T08:00:00", duration: "PT30M", distance: 3000, sport: "WALKING" },
    });
    expect(run?.type).toBe("WALK");
  });

  it("skips a non-run sport (cycling)", () => {
    expect(polarExerciseToRun({
      id: "c1",
      summary: { id: "c1", "start-time": "2026-07-10T08:00:00", duration: "PT1H", distance: 30000, sport: "CYCLING" },
    })).toBeNull();
  });

  it("uses the GPX route (points + raw HR series) and restamps Polar provenance", () => {
    const run = polarExerciseToRun({
      id: "g1",
      summary: { id: "g1", "start-time": "2026-07-10T08:00:00", "detailed-sport-info": "TRAIL_RUNNING" },
      gpx: GPX,
    });
    expect(run).toBeTruthy();
    expect(run!.points).toHaveLength(2);
    expect(run!.hrSamples).toEqual([
      { bpm: 140, t: Date.parse("2026-07-10T08:00:00Z") },
      { bpm: 160, t: Date.parse("2026-07-10T08:10:00Z") },
    ]);
    expect(run).toMatchObject({ type: "EASY", source: "watch", notes: "Imported from Polar", extId: "polar:g1" });
    // startedAt must be the GPX's UTC instant, NOT the summary's naive local
    // "start-time" — otherwise time-overlap dedupe against a CSV/GPX copy breaks.
    expect(run!.startedAt).toBe("2026-07-10T08:00:00.000Z");
  });

  it("returns null when there is neither a route nor a usable distance", () => {
    expect(polarExerciseToRun({
      id: "z1",
      summary: { id: "z1", "start-time": "2026-07-10T08:00:00", duration: "PT10M", distance: 0, sport: "RUNNING" },
    })).toBeNull();
  });
});

// ── Native deep-link OAuth plumbing (pure parts) ─────────────────────────────
import { expectedPolarStates } from "./polar";
import { buildAuthUrl } from "../cloudOauth";
import { classifyCloudReturn, CLOUD_OAUTH, cloudOauthProviderIds } from "../../cloudOauthPreinit";

describe("buildAuthUrl", () => {
  const spec = { authUrl: "https://flow.polar.com/oauth2/authorization", clientId: "cid", scope: "accesslink.read_all" };
  const opts = { state: "polar_import:n1", redirectUri: "https://run.example/" };

  it("omits PKCE params unless a challenge is supplied (Polar's live URL stays untouched)", () => {
    const url = new URL(buildAuthUrl(spec, opts));
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("state")).toBe("polar_import:n1");
    expect(url.searchParams.has("code_challenge")).toBe(false);
    expect(url.searchParams.has("code_challenge_method")).toBe(false);
  });

  it("appends S256 PKCE params when a challenge is supplied (Suunto opts in)", () => {
    const url = new URL(buildAuthUrl(spec, { ...opts, challenge: "chal" }));
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("cloud OAuth state helpers", () => {
  it("accepts both the web and the native state format for one nonce", () => {
    expect(expectedPolarStates("abc")).toEqual(["polar_import:abc", "polar_import:native:abc"]);
  });

  it("classifyCloudReturn tells web returns, native returns and non-provider loads apart", () => {
    expect(classifyCloudReturn("").provider).toBeNull();
    // Supabase's own PKCE return (?code= with no provider state) is NOT ours.
    expect(classifyCloudReturn("?code=supa").provider).toBeNull();
    expect(classifyCloudReturn("?state=other:xyz&code=c").provider).toBeNull();
    expect(classifyCloudReturn(`?state=${CLOUD_OAUTH.polar.statePrefix}:xyz&code=c`))
      .toEqual({ provider: "polar", kind: "web", code: "c", state: "polar_import:xyz" });
    // Native marker also starts with the plain prefix — must classify native,
    // not web (order of the startsWith checks is load-bearing).
    expect(classifyCloudReturn(`?state=${CLOUD_OAUTH.polar.nativeStatePrefix}:xyz&code=c`))
      .toEqual({ provider: "polar", kind: "native", code: "c", state: "polar_import:native:xyz" });
    // A denial carries error and no code — still classified so the URL gets
    // stripped (web) or bounced (native, to close the iOS browser sheet).
    expect(classifyCloudReturn(`?state=${CLOUD_OAUTH.polar.statePrefix}:xyz&error=access_denied`))
      .toEqual({ provider: "polar", kind: "web", code: null, state: "polar_import:xyz" });
  });

  it("classifies a COROS return, whose state carries no separator", () => {
    // COROS restricts `state` to a-z A-Z 0-9 (API Reference V2.0.6 §3.1.3), so
    // it is the one provider whose prefix and nonce run together. Native still
    // has to win over web: its prefix extends the plain one either way.
    const c = CLOUD_OAUTH.coros;
    expect(c.stateSep).toBe("");
    expect(classifyCloudReturn(`?state=${c.statePrefix}abc123&code=c`))
      .toEqual({ provider: "coros", kind: "web", code: "c", state: "corosimportabc123" });
    expect(classifyCloudReturn(`?state=${c.nativeStatePrefix}abc123&code=c`))
      .toEqual({ provider: "coros", kind: "native", code: "c", state: "corosimportnativeabc123" });
  });

  it("keeps every state a provider can emit within its own charset rule", () => {
    // A punctuated prefix under an empty separator would silently reintroduce
    // the characters COROS rejects, and the failure would surface only as a
    // refused authorization on a live account.
    for (const id of cloudOauthProviderIds) {
      const cfg = CLOUD_OAUTH[id];
      if ((cfg.stateSep ?? ":") !== "") continue;
      expect(cfg.statePrefix).toMatch(/^[a-zA-Z0-9]+$/);
      expect(cfg.nativeStatePrefix).toMatch(/^[a-zA-Z0-9]+$/);
    }
  });

  it("keeps providers unambiguous: disjoint state prefixes, unique keys and deep links", () => {
    const cfgs = cloudOauthProviderIds.map(id => CLOUD_OAUTH[id]);
    for (let i = 0; i < cfgs.length; i++) {
      for (let j = 0; j < cfgs.length; j++) {
        if (i === j) continue;
        // A shared prefix would let one provider's return classify as another's.
        expect(cfgs[j].statePrefix.startsWith(cfgs[i].statePrefix + ":")).toBe(false);
        expect(cfgs[j].statePrefix).not.toBe(cfgs[i].statePrefix);
      }
    }
    const allKeys = cfgs.flatMap(c => [c.codeKey, c.stateKey, c.nonceKey, c.verifierKey, c.deepLink]);
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });
});
