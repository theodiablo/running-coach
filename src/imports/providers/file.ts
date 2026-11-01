import { parseRunsCsv } from "../../utils/csv";
import { parseActivityFile } from "../../utils/gpx";
import { parseFitFile } from "../../utils/fit";
import type { ImportProvider, ImportParseResult } from "../types";

// Activity-file import: needs no vendor cooperation and works on web. CSV (Zepp / Strava
// exports) yields many runs without traces; GPX/TCX yields one run WITH route points,
// persisted by the caller via saveRoute. A user's own Strava export is their GDPR
// portability right, unlike the Strava *API*, whose agreement bans AI use of its data.
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
  // */* keeps every file selectable: mobile pickers resolve accept extensions to a
  // MIME/UTI first, and .fit/.gpx/.tcx aren't in Android's MimeTypeMap, so they render
  // grayed-out. parse() below is the real type gate.
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
