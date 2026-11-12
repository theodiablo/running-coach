// Codes Intl names that aren't a country a race can be in.
const NOT_A_COUNTRY = new Set(["EU", "EZ", "UN", "ZZ", "QO", "XA", "XB"]);
const ALIASES: Record<string, string> = { UK: "GB" };

let names: Intl.DisplayNames | null = null;
function regionName(code: string, locale?: string): string | undefined {
  try {
    const dn = locale ? new Intl.DisplayNames([locale], { type: "region", fallback: "none" })
      : (names ??= new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }));
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
