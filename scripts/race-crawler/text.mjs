// Pure text helpers shared by every source adapter. docs/race-crawler.md.

const HALF_KM = 21.1;
const MARATHON_KM = 42.2;
const MILE_KM = 1.609344;
const MAX_KM = 500;

// Letter boundaries, not \b: \b treats "Ó" as a non-letter, so it finds "Marató" inside "MARATÓTV3".
const HALF_RE =
  /(^|[^\p{L}\d])(?:half[\s-]?marathon|semi[\s-]?marathon|medi[ao]\s+marat[oó]n|mitja(?:\s+marat[oó])?|meia\s+maratona|halbmarathon)(?![\p{L}\d])/giu;
const MARATHON_RE = /(^|[^\p{L}\d])(ultra[\s-]?)?(?:marathon|marat[oó]n|marat[oó]|maratona)(?![\p{L}\d])/giu;
const NUM = "(\\d{1,3}(?:[.,]\\d+)?)";
const KM_RE = new RegExp(`${NUM}\\s?(?:kilom[eè]t(?:er|re)s?|kil[oó]metros?|kms?|k)(?![\\p{L}\\d])`, "giu");
const MILE_RE = new RegExp(`${NUM}\\s?(?:miles?|mi)(?![\\p{L}\\d])`, "giu");
const RANGE_RE = new RegExp(`between ${NUM} and ${NUM} kilomet`, "gi");

const num = (s) => Number(s.replace(",", "."));

function snap(km) {
  if (km >= 21 && km <= 21.2) return HALF_KM;
  if (km >= 42 && km <= 42.3) return MARATHON_KM;
  return Math.round(km * 10) / 10;
}

/**
 * Every race distance (km) a label or sentence names, ascending and de-duplicated. With `explicitWins`,
 * a stated figure beats the kind word beside it ("MIUT MARATHON 40 KMS" is 40, not 42.2).
 */
export function parseDistances(text, { explicitWins = false } = {}) {
  if (!text) return [];
  const found = [];
  let rest = String(text);
  rest = rest.replace(HALF_RE, (m, pre) => (found.push(HALF_KM), `${pre} `));
  rest = rest.replace(MARATHON_RE, (m, pre, ultra) => (ultra ? `${pre} ` : (found.push(MARATHON_KM), `${pre} `)));
  const fromWords = found.length;
  for (const m of rest.matchAll(RANGE_RE)) found.push(num(m[1]), num(m[2]));
  for (const m of rest.matchAll(KM_RE)) found.push(num(m[1]));
  for (const m of rest.matchAll(MILE_RE)) found.push(num(m[1]) * MILE_KM);
  const kept = explicitWins && found.length > fromWords ? found.slice(fromWords) : found;
  const kms = kept.map(snap).filter((km) => km > 0 && km <= MAX_KM);
  return [...new Set(kms)].sort((a, b) => a - b);
}

const STOPWORDS = new Set(
  "de del la el los las le les du des d l the of and y e et a en in at por para pour by al da do".split(" "),
);
// Words that say what kind of event it is, not which one.
const GENERIC = new Set(
  (
    "maraton marathon marato maratona media medio mitja semi half carrera cursa course courses run race running " +
    "trail popular internacional international ciudad city ville villa km edicion edition gran grand great " +
    "premio prix road festival series san sant saint silvestre sylvestre cross corrida nocturne nocturna " +
    "solidaria solidari solidaire popular"
  ).split(" "),
);
const ROMAN_RE = /^(?=[ivxl]+$)(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/;
const ORDINAL_RE = /^\d+(?:a|o|e|er|eme|ª|º|th|st|nd|rd)$/;
const YEAR_RE = /^(?:19|20)\d\d$/;
const DISTANCE_TOKEN_RE = /^\d+(?:k|km)?$/;

// A league or season tag after a comma names the series, not the race ("…, 9e. Circuit Trail Marina 26/27").
export const SERIES = /\d\d\/\d\d|\b(?:circuit|circuito|lliga|liga|copa|ctm|lmvs)\b/i;
// Only these also condemn the leading part: "circuit", "copa", "liga" are words of real race names too.
export const SEASON_TAG = /\d\d\/\d\d|\b(?:ctm|lmvs)\b/i;
export const isSeriesPart = (part, index) => (index === 0 ? SEASON_TAG : SERIES).test(part);

/** A name without its series tags: the comma-separated parts that are not a league or season. */
export const withoutSeries = (name) =>
  String(name ?? "")
    .split(",")
    .filter((p, i) => !isSeriesPart(p, i))
    .join(",");

export function stripAccents(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Name tokens with edition numbers, years and filler removed. */
export function nameTokens(name) {
  return stripAccents(name)
    .toLowerCase()
    .replace(/[^a-z0-9ªº]+/g, " ")
    .split(" ")
    .filter((t) => t && !STOPWORDS.has(t) && !YEAR_RE.test(t) && !ORDINAL_RE.test(t) && !ROMAN_RE.test(t));
}

/** The tokens that tell one race from another in the same town. */
export function distinctiveTokens(name) {
  return nameTokens(name).filter((t) => !GENERIC.has(t) && !DISTANCE_TOKEN_RE.test(t));
}

let countryIndex;
function buildCountryIndex() {
  const index = new Map([
    ["uk", "GB"],
    ["great britain", "GB"],
    ["espana", "ES"],
    ["espanya", "ES"],
    ["eire", "IE"],
  ]);
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const a of A) {
    for (const b of A) {
      const code = a + b;
      let name;
      try {
        name = names.of(code);
      } catch {
        continue;
      }
      const key = name && name !== code && stripAccents(name).toLowerCase();
      // First wins: FR before FX ("Metropolitan France"), GB before UK.
      if (key && !index.has(key)) index.set(key, code);
    }
  }
  return index;
}

/** ISO 3166-1 alpha-2 for an English country name or code; "" when unknown. */
export function countryCode(value) {
  const v = stripAccents(value).trim().toLowerCase();
  if (!v) return "";
  countryIndex ??= buildCountryIndex();
  if (countryIndex.has(v)) return countryIndex.get(v);
  return /^[a-z]{2}$/.test(v) ? v.toUpperCase() : "";
}

/** Bare hostname (no www) of a possibly scheme-less URL; "" when unparseable. */
export function hostOf(url) {
  if (!url) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Parsed JSON-LD blocks of a page, flattened through @graph. */
export function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      const parsed = JSON.parse(m[1]);
      for (const node of [].concat(parsed)) out.push(...(node["@graph"] ?? [node]));
    } catch {
      // A malformed block is the site's problem, not a reason to drop the page.
    }
  }
  return out;
}

export function haversineKm(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
