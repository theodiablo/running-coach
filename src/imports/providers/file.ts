import { parseRunsCsv } from "../../utils/csv";
import { parseActivityFile } from "../../utils/gpx";
import { parseFitFile } from "../../utils/fit";
import type { ImportProvider, ImportParseResult } from "../types";

// Activity-file import: the universal path that needs no vendor cooperation and
// works on web too. CSV (Zepp / Strava account exports — the pre-existing flow,
// unchanged underneath) yields many runs without traces; GPX/TCX (one activity
// per file, exported from Garmin Connect / Strava / most platforms) yields one
// run WITH its route points, which the caller persists via saveRoute.
//
// Note: importing a user's own Strava CSV/GPX export is their GDPR
// data-portability right — unrelated to the Strava *API*, which we deliberately
// don't use (its agreement bans AI-model use of API data; the coach reads runs).
function ext(name: string): string {
  const i = (name || "").lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export const fileProvider: ImportProvider = {
  id: "file",
  label: "Activity file (CSV, GPX, TCX, FIT)",
  kind: "file",
  platform: "both",
  isAvailable: () => true,
  // */* keeps every file selectable: mobile pickers (Android's document UI,
  // iOS Files) resolve accept extensions to a MIME/UTI before deciding what's
  // tappable, and .fit/.gpx/.tcx aren't in Android's MimeTypeMap — unresolved
  // extensions render grayed-out rather than "allow anything". parse() below
  // is the real type gate.
  fileAccept: ".csv,.gpx,.tcx,.fit,*/*",
  parse: ({ name, text, bytes }): ImportParseResult => {
    const e = ext(name);
    if (e === "gpx" || e === "tcx") {
      const res = parseActivityFile(text, e);
      return res.run ? { runs: [res.run] } : { runs: [], error: res.error };
    }
    if (e === "fit") {
      if (!bytes) return { runs: [], error: "Couldn't read that FIT file." };
      const res = parseFitFile(bytes);
      return res.run ? { runs: [res.run] } : { runs: [], error: res.error };
    }
    if (e === "csv") {
      const { runs, error } = parseRunsCsv(text);
      return { runs, error };
    }
    return { runs: [], error: "Unsupported file type — use a CSV, GPX, TCX or FIT export." };
  },
  help:
    "Export a single activity as FIT/GPX/TCX (includes the route map), or your " +
    "whole history as CSV from Zepp or Strava.",
};
