// ISO 3166-1 alpha-2, plus XK (Kosovo, user-assigned but what races there use). Excludes the
// reserved codes Intl also names (TA is Tristan da Cunha, not Tanzania).
const COUNTRY_CODES = new Set([
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
  "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS",
  "BT", "BV", "BW", "BY", "BZ", "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN",
  "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE",
  "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF",
  "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM",
  "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM",
  "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC",
  "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK",
  "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA",
  "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG",
  "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS",
  "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO",
  "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI",
  "VN", "VU", "WF", "WS", "XK", "YE", "YT", "ZA", "ZM", "ZW",
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

// A country code normalised to ISO 3166-1 alpha-2, or null if it isn't one a race can be in.
export function countryCode(input: string | null | undefined): string | null {
  const raw = (input || "").trim().toUpperCase();
  const code = ALIASES[raw] || raw;
  return COUNTRY_CODES.has(code) ? code : null;
}

export function countryName(code: string, locale?: string): string | null {
  return regionName(code, locale) ?? null;
}

// Every selectable country, named in the locale and sorted by that name.
export function countryOptions(locale = "en"): { code: string; name: string }[] {
  const options = [...COUNTRY_CODES].map(code => ({ code, name: countryName(code, locale) || code }));
  const collator = new Intl.Collator(locale);
  return options.sort((a, b) => collator.compare(a.name, b.name));
}
