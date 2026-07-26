// FIT (Garmin/ANT's binary format; what Zepp/Garmin/Strava exports use) decoder
// for the file import provider. Unlike GPX/TCX it's binary, read as bytes. Small
// and dependency-free: walks header + definition/data messages, pulls only
// `record` fields (position, altitude, HR, timestamp), skips unrecognized
// fields by their declared size, then reuses the SAME reducer (activityToRun)
// as GPX/TCX so stats agree point-for-point.
import { activityToRun, type ActivityParseResult } from "./gpx";
import type { TrackPointOrGap } from "./geo";

// FIT timestamps are seconds since 1989-12-31T00:00:00Z.
const FIT_EPOCH_OFFSET = 631065600;
// Semicircle → degrees: value * (180 / 2^31).
const SEMICIRCLE = 180 / 2 ** 31;

// "Invalid" sentinels per base type (a field present but unset). Sizes in bytes.
const BASE = {
  0: { size: 1, invalid: 0xff },                 // enum
  1: { size: 1, invalid: 0x7f },                 // sint8
  2: { size: 1, invalid: 0xff },                 // uint8
  3: { size: 2, invalid: 0x7fff },               // sint16
  4: { size: 2, invalid: 0xffff },               // uint16
  5: { size: 4, invalid: 0x7fffffff },           // sint32
  6: { size: 4, invalid: 0xffffffff },           // uint32
  7: { size: 1, invalid: 0x00 },                 // string
  8: { size: 4, invalid: 0xffffffff },           // float32
  9: { size: 8, invalid: 0xffffffff },           // float64
  10: { size: 1, invalid: 0x00 },                // uint8z
  11: { size: 2, invalid: 0x0000 },              // uint16z
  12: { size: 4, invalid: 0x00000000 },          // uint32z
  13: { size: 1, invalid: 0xff },                // byte
  14: { size: 8, invalid: 0x7fffffffffffffff },  // sint64
  15: { size: 8, invalid: 0xffffffffffffffff },  // uint64
  16: { size: 8, invalid: 0x0000000000000000 },  // uint64z
} as const;

const MSG_RECORD = 20; // global message number for a data point

type FieldDef = { num: number; size: number; base: number };
type MsgDef = { global: number; little: boolean; fields: FieldDef[]; devSize: number };

// Read a size-byte little/big-endian unsigned integer. Only the fields we care
// about are <= 32 bits, so a plain number is enough (no BigInt path needed).
function readUint(view: DataView, off: number, size: number, little: boolean): number {
  if (size === 1) return view.getUint8(off);
  if (size === 2) return view.getUint16(off, little);
  if (size === 4) return view.getUint32(off, little);
  // Fallback for odd sizes: assemble byte by byte.
  let v = 0;
  for (let i = 0; i < size; i++) v += view.getUint8(off + (little ? i : size - 1 - i)) * 2 ** (8 * i);
  return v;
}
function readInt(view: DataView, off: number, size: number, little: boolean): number {
  if (size === 1) return view.getInt8(off);
  if (size === 2) return view.getInt16(off, little);
  if (size === 4) return view.getInt32(off, little);
  return readUint(view, off, size, little);
}

// Decode a FIT byte buffer into a single activity run. Never throws — returns
// { error } on anything malformed.
export function parseFitFile(bytes: Uint8Array): ActivityParseResult {
  if (!bytes || bytes.length < 14) return { error: "That file is too small to be a FIT activity." };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const headerSize = view.getUint8(0);
  if (headerSize !== 12 && headerSize !== 14) return { error: "Couldn't read that file — it doesn't look like valid FIT." };
  // ".FIT" signature lives at bytes 8-11.
  const sig = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (sig !== ".FIT") return { error: "Couldn't read that file — it doesn't look like valid FIT." };
  const dataSize = view.getUint32(4, true);
  const dataEnd = Math.min(headerSize + dataSize, bytes.length);

  const defs: Record<number, MsgDef> = {}; // local message type → definition
  const pts: TrackPointOrGap[] = [];
  const hr: { bpm: number; t: number }[] = [];
  const times: number[] = [];
  let maxDistM = 0;
  let lastTimestamp = 0; // rolling full timestamp for compressed headers

  let off = headerSize;
  try {
    while (off < dataEnd) {
      const header = view.getUint8(off); off += 1;

      if (header & 0x80) {
        // Compressed-timestamp data message: bits 5-6 local type, bits 0-4 offset.
        const local = (header >> 5) & 0x3;
        const timeOffset = header & 0x1f;
        if (lastTimestamp) lastTimestamp += (timeOffset - (lastTimestamp & 0x1f)) & 0x1f;
        off = readDataMessage(view, off, defs[local], lastTimestamp, pts, hr, times, v => { if (v > maxDistM) maxDistM = v; });
        continue;
      }

      const local = header & 0x0f;
      if (header & 0x40) {
        // Definition message.
        off += 1; // reserved
        const little = view.getUint8(off) === 0; off += 1; // architecture: 0=LE
        const global = readUint(view, off, 2, little); off += 2;
        const n = view.getUint8(off); off += 1;
        const fields: FieldDef[] = [];
        for (let i = 0; i < n; i++) {
          fields.push({ num: view.getUint8(off), size: view.getUint8(off + 1), base: view.getUint8(off + 2) & 0x1f });
          off += 3;
        }
        let devSize = 0;
        if (header & 0x20) {
          const dn = view.getUint8(off); off += 1;
          for (let i = 0; i < dn; i++) { devSize += view.getUint8(off + 1); off += 3; }
        }
        defs[local] = { global, little, fields, devSize };
      } else {
        // Normal data message.
        off = readDataMessage(view, off, defs[local], null, pts, hr, times, v => { if (v > maxDistM) maxDistM = v; });
      }
    }
  } catch {
    // Truncated/corrupt tail — keep whatever we decoded so a partial file still imports.
  }

  const fallback = times.length >= 2 && maxDistM > 0
    ? { startMs: times[0], endMs: times[times.length - 1], km: maxDistM / 1000 }
    : null;
  return activityToRun(pts, hr, "FIT import", fallback);
}

// Consume one data message body per its definition, extracting record fields.
// `compressedTime` is the header-supplied timestamp for compressed messages (else
// the message's own field 253 is used). Returns the new offset.
function readDataMessage(
  view: DataView,
  start: number,
  def: MsgDef | undefined,
  compressedTime: number | null,
  pts: TrackPointOrGap[],
  hr: { bpm: number; t: number }[],
  times: number[],
  onDistance: (m: number) => void,
): number {
  let off = start;
  if (!def) return off; // data before its definition — unrecoverable, but caller's loop guards the end
  const off0 = off;
  const isRecord = def.global === MSG_RECORD;
  let ts = compressedTime ?? 0;
  let lat: number | null = null, lng: number | null = null, alt: number | null = null, bpm: number | null = null;

  for (const f of def.fields) {
    const b = BASE[f.base as keyof typeof BASE];
    if (isRecord) {
      const signed = f.base === 1 || f.base === 3 || f.base === 5;
      const raw = signed ? readInt(view, off, f.size, def.little) : readUint(view, off, f.size, def.little);
      const invalid = b ? raw === b.invalid : false;
      if (!invalid) {
        switch (f.num) {
          case 253: ts = raw + FIT_EPOCH_OFFSET; break;                 // timestamp (s)
          case 0: lat = raw * SEMICIRCLE; break;                        // position_lat
          case 1: lng = raw * SEMICIRCLE; break;                        // position_long
          case 2: alt = raw / 5 - 500; break;                           // altitude
          case 78: alt = raw / 5 - 500; break;                          // enhanced_altitude (wins if present)
          case 3: bpm = raw; break;                                     // heart_rate
          case 5: onDistance(raw / 100); break;                         // cumulative distance (m)
        }
      }
    }
    off += f.size;
  }
  off += def.devSize; // skip developer fields wholesale
  // Guard against a zero-length definition looping forever.
  if (off <= off0) off = off0 + 1;

  if (isRecord && ts) {
    const tMs = ts * 1000;
    times.push(tMs);
    if (lat != null && lng != null) pts.push([lat, lng, tMs, alt]);
    if (bpm != null && bpm > 0) hr.push({ bpm, t: tMs });
  }
  return off;
}
