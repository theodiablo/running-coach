// Locale detection for pre-auth surfaces: the synced settings blob only exists after sign-in, so the boot locale comes
// from a per-device localStorage override (explicit language pick), else the browser language. Mirrors the consent pattern.

export type LangId = "en" | "es" | "fr";
export const LANG_IDS: readonly LangId[] = ["en", "es", "fr"];

export const RC_LANG_KEY = "rc_lang";

export const isLangId = (v: unknown): v is LangId =>
  LANG_IDS.includes(v as LangId);

export function getStoredLang(): LangId | null {
  try {
    const v = localStorage.getItem(RC_LANG_KEY);
    return isLangId(v) ? v : null;
  } catch {
    return null;
  }
}

export function detectInitialLocale(): LangId {
  const stored = getStoredLang();
  if (stored) return stored;
  if (typeof navigator === "undefined") return "en";
  // The whole preference list: "de, fr" is a French reader, not an English one.
  const prefs = navigator.languages?.length ? navigator.languages : [navigator.language || ""];
  for (const tag of prefs) {
    const prefix = (tag || "").slice(0, 2).toLowerCase();
    if (isLangId(prefix)) return prefix;
  }
  return "en";
}
