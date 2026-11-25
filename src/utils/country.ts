// Codes Intl names that aren't a country a race can be in; the first row mirrors
// races_country_not_reserved (TA is Tristan da Cunha, which a typed "Tanzania" is not).
const NOT_A_COUNTRY = new Set([
  "AC", "AN", "CP", "CQ", "DG", "EA", "EU", "EZ", "FX", "IC", "SU", "TA", "UN", "YU", "ZZ",
  "QO", "XA", "XB",
]);
const ALIASES: Record<string, string> = { UK: "GB" };

const namers = new Map<string, Intl.DisplayNames>();
function regionName(code: string, locale = "en"): string | undefined {
  try {
    let dn = namers.get(locale);
    if (!dn) namers.set(locale, dn = new Intl.DisplayNames([locale], { type: "region", fallback: "none" }));
    return dn.of(code);
  } catch {
    return undefined;
  }
}

// A typed country normalised to its ISO 3166-1 alpha-2 code, or null if it isn't one.
export function countryCode(input: string | null | undefined): string | null {
  const raw = (input || "").trim().toUpperCase();
  const code = ALIASES[raw] || raw;
  if (!/^[A-Z]{2}$/.test(code) || NOT_A_COUNTRY.has(code)) return null;
  return regionName(code) ? code : null;
}

export function countryName(code: string, locale?: string): string | null {
  return regionName(code, locale) ?? null;
}
