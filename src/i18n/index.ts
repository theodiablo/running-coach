// The one i18n seam. English is bundled (fallback for ErrorBoundary and first paint);
// es/fr are dynamic imports (own chunks). Components use useTranslation(); class
// components and pure modules import the bound `t` from here.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";
import { RC_LANG_KEY, isLangId, type LangId } from "./detect";

export { detectInitialLocale, getStoredLang, isLangId, RC_LANG_KEY, LANG_IDS } from "./detect";
export type { LangId } from "./detect";

export const LANGS: { id: LangId; label: string }[] = [
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
  { id: "fr", label: "Français" },
];

// BCP-47 tags for Date/Intl formatting; en keeps "en-GB" so English dates
// render byte-identically to the pre-i18n app.
const LOCALE_TAG: Record<LangId, string> = { en: "en-GB", es: "es-ES", fr: "fr-FR" };

const loaders: Record<LangId, () => Promise<{ default: object }>> = {
  en: () => Promise.resolve({ default: en }),
  es: () => import("./locales/es"),
  fr: () => import("./locales/fr"),
};

export function initI18n(initial: LangId): Promise<void> {
  // With inline resources and no backend plugin this init is synchronous, so
  // t() works immediately — main.tsx calls it before createRoot.
  void i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false }, // React escapes already
    returnNull: false,
  });
  if (typeof document !== "undefined") document.documentElement.lang = "en";
  // Boot detection must not persist the browser language to localStorage; only an explicit
  // pick or the synced setting does. Returns the load promise so main.tsx awaits the es/fr
  // chunk before first paint. setLocale never rejects, so awaiting is always safe.
  return initial === "en" ? Promise.resolve() : setLocale(initial, { persist: false });
}

export async function setLocale(lang: LangId, opts: { persist?: boolean } = {}): Promise<void> {
  if (!isLangId(lang)) return;
  try {
    // The es/fr bundle is a dynamic import(); a stale chunk or offline load rejects here.
    // Catch it (callers use `void setLocale(...)`), stay on the current language, and DON'T
    // persist rc_lang so a later boot retries.
    if (!i18n.hasResourceBundle(lang, "translation")) {
      const mod = await loaders[lang]();
      i18n.addResourceBundle(lang, "translation", mod.default);
    }
    await i18n.changeLanguage(lang);
    document.documentElement.lang = lang;
    if (opts.persist !== false) {
      try { localStorage.setItem(RC_LANG_KEY, lang); } catch { /* private mode */ }
    }
  } catch (err) {
    if (typeof console !== "undefined") console.warn("setLocale failed to load", lang, err);
  }
}

export const currentLang = (): LangId => (isLangId(i18n.language) ? i18n.language : "en");
export const currentLocaleTag = (): string => LOCALE_TAG[currentLang()];

// Short localized weekday label for a Monday-based index 0–6 (the DAYS order).
// Derived via Intl so there is nothing to hand-translate. 2024-01-01 is a Monday.
const dayCache = new Map<string, string[]>();
export function dayName(i: number): string {
  const tag = currentLocaleTag();
  let names = dayCache.get(tag);
  if (!names) {
    const fmt = new Intl.DateTimeFormat(tag, { weekday: "short", timeZone: "UTC" });
    names = Array.from({ length: 7 }, (_, d) => fmt.format(new Date(Date.UTC(2024, 0, 1 + d))));
    dayCache.set(tag, names);
  }
  return names[((i % 7) + 7) % 7];
}

// Bound t for non-hook call sites (class components, pure utility modules).
export const t = i18n.t.bind(i18n);
export default i18n;
