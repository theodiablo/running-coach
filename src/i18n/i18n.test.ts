import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import en from "./locales/en";
import es from "./locales/es";
import fr from "./locales/fr";
import marketingEn from "../marketing/marketing.en.json";
import marketingEs from "../marketing/marketing.es.json";
import marketingFr from "../marketing/marketing.fr.json";
import marketingCopy from "../marketing/copy.json";
import { detectInitialLocale, isLangId, RC_LANG_KEY } from "./detect";
import { dayName, setLocale } from "./index";

// ---- key-set parity ---------------------------------------------------------
// A key present in en but missing in es/fr would silently fall back to English
// at runtime; fail CI instead. Extra keys in es/fr are equally a bug (dead
// weight or a typo'd key that will never be looked up).

type Tree = Record<string, unknown>;

function keyPaths(obj: Tree, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" && !Array.isArray(v) ? keyPaths(v as Tree, path) : [path];
  });
}

function stringValues(obj: Tree): string[] {
  return Object.values(obj).flatMap(v =>
    v && typeof v === "object" && !Array.isArray(v) ? stringValues(v as Tree) : typeof v === "string" ? [v] : [],
  );
}

function stringEntries(obj: Tree, prefix = ""): [string, string][] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) return stringEntries(v as Tree, path);
    return typeof v === "string" ? [[path, v] as [string, string]] : [];
  });
}

// Interpolation slots must survive translation — a missing {{var}} renders a
// hole in the sentence for that locale.
function slots(obj: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      slots(v as Tree, path).forEach((sv, sk) => out.set(sk, sv));
    } else if (typeof v === "string") {
      const vars = [...v.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort().join(",");
      out.set(path, vars);
    }
  }
  return out;
}

describe("locale dictionaries", () => {
  it.each([["es", es], ["fr", fr]] as const)("%s has the same key set as en", (_lang, dict) => {
    const enKeys = keyPaths(en).sort();
    const langKeys = keyPaths(dict as Tree).sort();
    expect(langKeys).toEqual(enKeys);
  });

  it.each([["es", es], ["fr", fr]] as const)("%s keeps every en interpolation slot", (_lang, dict) => {
    const enSlots = slots(en);
    const langSlots = slots(dict as Tree);
    for (const [key, vars] of enSlots) {
      expect(langSlots.get(key), `interpolation vars for ${key}`).toBe(vars);
    }
  });

  it.each([
    ["es", es, marketingEs],
    ["fr", fr, marketingFr],
  ] as const)("%s copy does not use English-style em dashes", (_lang, app, marketing) => {
    expect([...stringValues(app as Tree), ...stringValues(marketing as Tree)].filter(value => value.includes("—"))).toEqual([]);
  });

  // French app copy says `tu`. `vous` is only for people who aren't users yet:
  // the public watch page (and marketing, which lives in its own files).
  it("fr app copy addresses the runner as tu", () => {
    const offenders = stringEntries(fr as Tree)
      .filter(([path, value]) => /\b(vous|votre|vos)\b/i.test(value) && !path.startsWith("liveShare.public."))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("fr marketing keeps vouvoiement", () => {
    expect(stringValues(marketingFr as Tree).some(v => /\b(vous|votre|vos)\b/i.test(v))).toBe(true);
  });
});

// ---- no dangling t() keys ---------------------------------------------------
// Every t("literal.key") referenced in source must resolve in the dictionary,
// or it renders the raw key string at runtime. The parity test above does NOT
// catch this (a key missing from ALL of en/es/fr is "in parity" yet broken),
// so scan the source and check each referenced literal key exists — plural
// suffixes (_one/_other) and dynamic-prefix keys ("a.b." + x) accounted for.

const PLURAL_SUFFIXES = ["", "_zero", "_one", "_two", "_few", "_many", "_other"];

function hasExact(root: Tree, path: string): boolean {
  let o: unknown = root;
  for (const k of path.split(".")) {
    if (o && typeof o === "object" && k in (o as Tree)) o = (o as Tree)[k];
    else return false;
  }
  return true;
}
const resolves = (root: Tree, key: string) => PLURAL_SUFFIXES.some(s => hasExact(root, key + s));

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = `${dir}/${e}`;
    if (statSync(p).isDirectory()) sourceFiles(p, acc);
    else if (/\.(tsx|ts)$/.test(e) && !/\.test\.tsx?$/.test(e)) acc.push(p);
  }
  return acc;
}

describe("no dangling t() keys", () => {
  // `t(` not preceded by a word char (so `set("x"` / `get("x"` don't match).
  const re = /(?<![A-Za-z0-9_])t\(\s*"([A-Za-z0-9_.]+)"/g;
  const files = sourceFiles("src");
  // Mirror ensureMarketingI18n: brand + hero come from copy.json at runtime.
  const marketing: Tree = {
    ...(marketingEn as Tree),
    brand: marketingCopy.brand,
    heroLine1: marketingCopy.heroLine1,
    heroLine2: marketingCopy.heroLine2,
  };

  it("every referenced literal key resolves in en", () => {
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const dict = f.includes("/marketing/") ? marketing : (en as Tree);
      for (const m of src.matchAll(re)) {
        const key = m[1];
        if (key.endsWith(".")) continue; // dynamic prefix: t("a.b." + x)
        if (!resolves(dict, key)) missing.push(`${key}  (${f})`);
      }
    }
    expect(missing, `unresolved t() keys:\n${missing.join("\n")}`).toEqual([]);
  });
});

// ---- detection --------------------------------------------------------------

describe("detectInitialLocale", () => {
  afterEach(() => {
    localStorage.removeItem(RC_LANG_KEY);
    vi.unstubAllGlobals();
  });

  it("prefers the stored override", () => {
    localStorage.setItem(RC_LANG_KEY, "fr");
    vi.stubGlobal("navigator", { language: "es-MX" });
    expect(detectInitialLocale()).toBe("fr");
  });

  it("falls back to the browser language prefix", () => {
    vi.stubGlobal("navigator", { language: "es-MX" });
    expect(detectInitialLocale()).toBe("es");
  });

  it("defaults to en for unsupported languages", () => {
    vi.stubGlobal("navigator", { language: "de-DE" });
    expect(detectInitialLocale()).toBe("en");
  });

  it("ignores garbage in localStorage", () => {
    localStorage.setItem(RC_LANG_KEY, "xx");
    vi.stubGlobal("navigator", { language: "de" });
    expect(detectInitialLocale()).toBe("en");
  });

  it("isLangId accepts exactly the supported set", () => {
    expect(isLangId("en") && isLangId("es") && isLangId("fr")).toBe(true);
    expect(isLangId("de")).toBe(false);
    expect(isLangId(null)).toBe(false);
  });
});

// ---- setLocale side-effects --------------------------------------------------

describe("setLocale", () => {
  beforeEach(() => localStorage.removeItem(RC_LANG_KEY));
  afterEach(async () => {
    await setLocale("en", { persist: false });
    localStorage.removeItem(RC_LANG_KEY);
  });

  it("sets <html lang> and persists rc_lang", async () => {
    await setLocale("es");
    expect(document.documentElement.lang).toBe("es");
    expect(localStorage.getItem(RC_LANG_KEY)).toBe("es");
  });

  it("skips persistence when asked (boot detection)", async () => {
    await setLocale("fr", { persist: false });
    expect(document.documentElement.lang).toBe("fr");
    expect(localStorage.getItem(RC_LANG_KEY)).toBeNull();
  });

  it("localizes weekday labels", async () => {
    expect(dayName(0)).toBe("Mon");
    await setLocale("fr", { persist: false });
    expect(dayName(0).toLowerCase().startsWith("lun")).toBe(true);
    expect(dayName(6).toLowerCase().startsWith("dim")).toBe(true);
  });
});
