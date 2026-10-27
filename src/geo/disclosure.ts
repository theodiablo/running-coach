import { BG_LOC_DISCLOSED_KEY } from "../constants";

// Whether this install has accepted the background-location disclosure (a Play
// requirement before the OS prompt). Per-device, set only after a grant.
export const isBgLocationDisclosed = (): boolean => {
  try { return localStorage.getItem(BG_LOC_DISCLOSED_KEY) === "1"; } catch { return false; }
};

export const markBgLocationDisclosed = (): void => {
  try { localStorage.setItem(BG_LOC_DISCLOSED_KEY, "1"); } catch { /* quota — non-fatal */ }
};
