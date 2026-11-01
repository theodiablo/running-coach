// Marketing i18n: a SEPARATE "marketing" namespace, imported only by MarketingGate. This
// web-only chunk is constant-folded out of native builds (VITE_NATIVE_BUILD), so these
// strings never ship in the APK. Brand + hero headline come from copy.json (shared with
// the OG-image generator) so page and social card can't drift.
import i18n from "i18next";
import { RC_LANG_KEY, setLocale, isLangId, type LangId } from "../i18n";
import copy from "./copy.json";
import en from "./marketing.en.json";
import es from "./marketing.es.json";
import fr from "./marketing.fr.json";

let registered = false;

// Register once; idempotent so re-mounting MarketingGate is cheap.
export function ensureMarketingI18n(): void {
  if (registered) return;
  registered = true;
  i18n.addResourceBundle("en", "marketing", {
    ...en,
    brand: copy.brand,
    heroLine1: copy.heroLine1,
    heroLine2: copy.heroLine2,
  }, true, true);
  i18n.addResourceBundle("es", "marketing", es, true, true);
  i18n.addResourceBundle("fr", "marketing", fr, true, true);
}

// Language switch for the marketing page. The es/fr marketing dictionaries are static, so
// the flip is instant. NOT routed through app-wide setLocale on the critical path: that
// downloads the ~50KB app chunk and can fail, leaving a dead tap. Flip, persist, then warm
// the app bundle best-effort for LoginScreen; a failed warm leaves it in English.
export function setMarketingLocale(lang: LangId): void {
  if (!isLangId(lang)) return;
  void i18n.changeLanguage(lang); // marketing bundle already present → instant
  document.documentElement.lang = lang;
  try { localStorage.setItem(RC_LANG_KEY, lang); } catch { /* private mode */ }
  void setLocale(lang); // warm the app "translation" chunk for LoginScreen
}
