import { describe, it, expect } from "vitest";
import { fmt, ymd, addWeeks, estMin, cleanDesc, parseDur } from "./format";

describe("fmt.pace", () => {
  const pace = fmt.pace as (secondsPerKm: number | null) => string;

  it("formats seconds-per-km as m:ss", () => {
    expect(fmt.pace(330)).toBe("5:30");
    expect(fmt.pace(65)).toBe("1:05");
  });
  it("returns placeholder for missing/zero", () => {
    expect(fmt.pace(0)).toBe("--:--");
    expect(pace(null)).toBe("--:--");
  });
});

describe("fmt.dur", () => {
  it("formats under an hour as m:ss", () => {
    expect(fmt.dur(330)).toBe("5:30");
  });
  it("formats over an hour as h:mm:ss", () => {
    expect(fmt.dur(3661)).toBe("1:01:01");
    expect(fmt.dur(7200)).toBe("2:00:00");
  });
  it("returns placeholder for falsy", () => {
    expect(fmt.dur(0)).toBe("--");
  });
});

describe("fmt.mins", () => {
  it("formats sub-hour as Nmin", () => {
    expect(fmt.mins(30)).toBe("30min");
    expect(fmt.mins(45)).toBe("45min");
  });
  it("formats whole hours as Nh", () => {
    expect(fmt.mins(60)).toBe("1h");
    expect(fmt.mins(120)).toBe("2h");
  });
  it("formats mixed durations as NhMM (no raw float)", () => {
    expect(fmt.mins(90)).toBe("1h30");
    expect(fmt.mins(110)).toBe("1h50");
    expect(fmt.mins(65)).toBe("1h05");
  });
  it("returns empty string for nullish/blank", () => {
    expect(fmt.mins(null)).toBe("");
    expect(fmt.mins("")).toBe("");
  });
});

describe("parseDur", () => {
  it("parses m:ss goal times and paces", () => {
    expect(parseDur("50:00")).toBe(3000);
    expect(parseDur("5:30")).toBe(330);
  });
  it("parses h:mm:ss times", () => {
    expect(parseDur("1:45:00")).toBe(6300);
  });
  it("round-trips with fmt.dur / fmt.pace", () => {
    expect(parseDur(fmt.dur(3000))).toBe(3000);
    expect(parseDur(fmt.pace(312))).toBe(312);
  });
  it("tolerates surrounding whitespace", () => {
    expect(parseDur("  50:00 ")).toBe(3000);
  });
  it("returns null for blank or non-numeric input", () => {
    expect(parseDur("")).toBeNull();
    expect(parseDur(null)).toBeNull();
    expect(parseDur("5:")).toBeNull();
    expect(parseDur("abc")).toBeNull();
  });
});

describe("ymd", () => {
  it("formats a date using local calendar parts (no UTC shift)", () => {
    // Construct via local Date parts; ymd must echo them back regardless of TZ.
    const d = new Date(2026, 0, 5, 0, 0, 0); // 5 Jan 2026, local midnight
    expect(ymd(d)).toBe("2026-01-05");
  });
});

describe("addWeeks", () => {
  it("adds whole weeks from a fixed date", () => {
    const from = new Date(2026, 0, 5); // Mon 5 Jan 2026
    expect(addWeeks(12, from)).toBe("2026-03-30");
    expect(addWeeks(0, from)).toBe("2026-01-05");
  });
  it("crosses month/year boundaries", () => {
    expect(addWeeks(4, new Date(2026, 11, 21))).toBe("2027-01-18");
  });
});

describe("estMin", () => {
  it("estimates minutes from km and pace", () => {
    expect(estMin(10, 360)).toBe("60 min");
  });
  it("returns empty string when inputs missing", () => {
    expect(estMin(0, 360)).toBe("");
    expect(estMin(10, 0)).toBe("");
  });
});

describe("cleanDesc", () => {
  it("strips a trailing slot-label estimate", () => {
    expect(cleanDesc("Easy run · ~30 min")).toBe("Easy run");
    expect(cleanDesc("Long run · 90 min")).toBe("Long run");
  });
  it("leaves descriptions without a trailing estimate untouched", () => {
    expect(cleanDesc("Tempo run — comfortably hard")).toBe("Tempo run — comfortably hard");
  });
  it("handles nullish input", () => {
    expect(cleanDesc(null)).toBe("");
  });
});
