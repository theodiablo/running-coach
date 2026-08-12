import { describe, it, expect, vi, beforeEach } from "vitest";

const native = vi.hoisted(() => ({
  isAndroid: true,
  plugin: {
    setHrJournal: vi.fn(),
    getHrJournal: vi.fn(),
    clearHrJournal: vi.fn(),
  },
}));

vi.mock("@capacitor/core", () => ({ registerPlugin: () => native.plugin }));
vi.mock("../native", () => ({ get isAndroid() { return native.isAndroid; } }));

import { armHrJournal, clearHrJournal, disarmHrJournal, readHrJournal, resetHrJournal } from "./hrJournal";

// Standard HR measurement, the plugin's compact hex: flags 0x00 then the bpm.
const hex = (bpm: number) => "00" + bpm.toString(16).padStart(2, "0");

beforeEach(() => {
  native.isAndroid = true;
  for (const fn of Object.values(native.plugin)) fn.mockReset().mockResolvedValue(undefined);
  native.plugin.getHrJournal.mockResolvedValue({ entries: [] });
});

describe("readHrJournal", () => {
  it("parses journalled measurements into samples, sorted", async () => {
    native.plugin.getHrJournal.mockResolvedValue({
      entries: [{ t: 2000, v: hex(152) }, { t: 1000, v: hex(150) }],
    });
    expect(await readHrJournal()).toEqual([
      { bpm: 150, t: 1000 },
      { bpm: 152, t: 2000 },
    ]);
  });

  it("skips torn or malformed lines rather than losing the journal", async () => {
    native.plugin.getHrJournal.mockResolvedValue({
      entries: [
        { t: 1000, v: hex(150) },
        { t: 1500, v: "0" },        // truncated mid-write
        { t: "nope", v: hex(150) }, // unusable timestamp
        { v: hex(150) },            // no timestamp
        null,
        { t: 2000, v: "0000" },     // 0 bpm = no sensor contact
        { t: 2500, v: hex(155) },
      ],
    });
    expect(await readHrJournal()).toEqual([
      { bpm: 150, t: 1000 },
      { bpm: 155, t: 2500 },
    ]);
  });

  it("resolves empty when the shell has no journal (unpatched plugin)", async () => {
    native.plugin.getHrJournal.mockRejectedValue(new Error("not implemented"));
    expect(await readHrJournal()).toEqual([]);
  });

  it("never touches the bridge off Android", async () => {
    native.isAndroid = false;
    expect(await readHrJournal()).toEqual([]);
    resetHrJournal(); armHrJournal(); disarmHrJournal(); clearHrJournal();
    expect(native.plugin.getHrJournal).not.toHaveBeenCalled();
    expect(native.plugin.setHrJournal).not.toHaveBeenCalled();
    expect(native.plugin.clearHrJournal).not.toHaveBeenCalled();
  });
});

describe("arming", () => {
  it("clears leftovers before arming, so a run starts empty", async () => {
    resetHrJournal();
    await vi.waitFor(() => expect(native.plugin.setHrJournal).toHaveBeenCalledWith({ enabled: true }));
    expect(native.plugin.clearHrJournal.mock.invocationCallOrder[0])
      .toBeLessThan(native.plugin.setHrJournal.mock.invocationCallOrder[0]);
  });

  it("re-arms a resumed run without clearing what the crash left behind", () => {
    armHrJournal();
    expect(native.plugin.setHrJournal).toHaveBeenCalledWith({ enabled: true });
    expect(native.plugin.clearHrJournal).not.toHaveBeenCalled();
  });

  it("disarms without clearing, so the save can still read the run", () => {
    disarmHrJournal();
    expect(native.plugin.setHrJournal).toHaveBeenCalledWith({ enabled: false });
    expect(native.plugin.clearHrJournal).not.toHaveBeenCalled();
  });

  it("swallows a rejecting bridge", async () => {
    native.plugin.clearHrJournal.mockRejectedValue(new Error("nope"));
    native.plugin.setHrJournal.mockRejectedValue(new Error("nope"));
    expect(() => { resetHrJournal(); armHrJournal(); disarmHrJournal(); clearHrJournal(); }).not.toThrow();
    await vi.waitFor(() => expect(native.plugin.clearHrJournal).toHaveBeenCalled());
  });
});
