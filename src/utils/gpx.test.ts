// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { parseActivityFile } from "./gpx";

// ~1.11 km of due-north track (0.01° lat ≈ 1.11 km), 3 points, 10 min, with
// Garmin-style hr extensions and rising elevation.
const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <trk><name>Morning Run</name><trkseg>
    <trkpt lat="45.000" lon="5.000"><ele>200</ele><time>2026-07-10T08:00:00Z</time>
      <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>140</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
    <trkpt lat="45.005" lon="5.000"><ele>210</ele><time>2026-07-10T08:05:00Z</time>
      <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>150</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
    <trkpt lat="45.010" lon="5.000"><ele>220</ele><time>2026-07-10T08:10:00Z</time>
      <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>160</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
  </trkseg></trk>
</gpx>`;

const TCX = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities><Activity Sport="Running"><Lap>
    <Track>
      <Trackpoint><Time>2026-07-10T08:00:00Z</Time>
        <Position><LatitudeDegrees>45.000</LatitudeDegrees><LongitudeDegrees>5.000</LongitudeDegrees></Position>
        <AltitudeMeters>200</AltitudeMeters><HeartRateBpm><Value>142</Value></HeartRateBpm></Trackpoint>
      <Trackpoint><Time>2026-07-10T08:06:00Z</Time>
        <Position><LatitudeDegrees>45.010</LatitudeDegrees><LongitudeDegrees>5.000</LongitudeDegrees></Position>
        <AltitudeMeters>215</AltitudeMeters><HeartRateBpm><Value>158</Value></HeartRateBpm></Trackpoint>
    </Track>
  </Lap></Activity></Activities>
</TrainingCenterDatabase>`;

describe("parseActivityFile — GPX", () => {
  it("parses points, distance, duration, elevation and HR", () => {
    const res = parseActivityFile(GPX, "gpx");
    expect(res.error).toBeUndefined();
    const run = res.run!;
    expect(run.date).toBe("2026-07-10");
    expect(run.km).toBeGreaterThan(1);
    expect(run.km).toBeLessThan(1.25);
    expect(run.durationSec).toBe(600);
    expect(run.hr).toBe(150);           // avg of 140/150/160
    expect(run.hrMax).toBe(160);
    expect(run.elevation).toBe(20);     // 200 → 220
    expect(run.source).toBe("file");
    expect(run.startedAt).toBe("2026-07-10T08:00:00.000Z");
    expect(run.points).toHaveLength(3);
    expect(run.points![0]).toEqual([45, 5, Date.parse("2026-07-10T08:00:00Z"), 200]);
    // The raw HR stream is kept (not just avg/max) so the import powers the
    // detail HR chart + time-in-zone card, folded into stats.hrSamples on save.
    expect(run.hrSamples).toEqual([
      { bpm: 140, t: Date.parse("2026-07-10T08:00:00Z") },
      { bpm: 150, t: Date.parse("2026-07-10T08:05:00Z") },
      { bpm: 160, t: Date.parse("2026-07-10T08:10:00Z") },
    ]);
  });

  it("tolerates missing elevation and HR", () => {
    const bare = GPX.replace(/<ele>\d+<\/ele>/g, "").replace(/<extensions>[\s\S]*?<\/extensions>/g, "");
    const res = parseActivityFile(bare, "gpx");
    expect(res.error).toBeUndefined();
    expect(res.run!.elevation).toBeUndefined();
    expect(res.run!.hr).toBeNull();
  });

  it("rejects files without usable trackpoints or with no distance", () => {
    expect(parseActivityFile("<gpx></gpx>", "gpx").error).toBeTruthy();
    expect(parseActivityFile("not xml at all", "gpx").error).toBeTruthy();
    expect(parseActivityFile("", "gpx").error).toBe("Empty file.");
  });
});

describe("parseActivityFile — TCX", () => {
  it("imports an indoor/treadmill TCX (Time + DistanceMeters, no Position)", () => {
    const treadmill = `<?xml version="1.0"?>
<TrainingCenterDatabase><Activities><Activity Sport="Running"><Lap><Track>
  <Trackpoint><Time>2026-07-10T08:00:00Z</Time><DistanceMeters>0</DistanceMeters>
    <HeartRateBpm><Value>140</Value></HeartRateBpm></Trackpoint>
  <Trackpoint><Time>2026-07-10T08:30:00Z</Time><DistanceMeters>5000</DistanceMeters>
    <HeartRateBpm><Value>160</Value></HeartRateBpm></Trackpoint>
</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
    const res = parseActivityFile(treadmill, "tcx");
    expect(res.error).toBeUndefined();
    const run = res.run!;
    expect(run.km).toBe(5);
    expect(run.durationSec).toBe(1800);
    expect(run.hr).toBe(150);
    expect(run.points).toBeUndefined(); // no GPS → no route/map
    expect(run.elevation).toBeUndefined();
  });

  it("parses trackpoints with position, altitude and HR", () => {
    const res = parseActivityFile(TCX, "tcx");
    expect(res.error).toBeUndefined();
    const run = res.run!;
    expect(run.km).toBeGreaterThan(1);
    expect(run.durationSec).toBe(360);
    expect(run.hr).toBe(150);           // avg of 142/158
    expect(run.hrMax).toBe(158);
    expect(run.points).toHaveLength(2);
  });
});
