// ATS Sport (registration and timing platform, mostly southern France): sitemap
// for discovery, the event page's SportsEvent JSON-LD and its course list for
// extraction. Pages carry no coordinates: the town's centre comes from the
// government commune API (geo.api.gouv.fr), best effort.
import { countryCode, jsonLdBlocks, parseDistances, stripAccents } from "../text.mjs";

export const id = "atssport";
export const firstHand = true;
const BASE = "https://ats-sport.com";
export const SITEMAPS = [`${BASE}/sitemap.xml`];
export const GEO_HOST = "geo.api.gouv.fr";

const STATUS = { EventCancelled: "cancelled", EventPostponed: "postponed", EventScheduled: "scheduled" };
// A course's own type ("Distance :" on the page); kids' races, walks, bikes and swimruns are not runs.
const RUN_TYPE =
  /\btrail\b|course sur route|course nature|\bsemi[ -]?marathon|\bmarathon|\bcross\b(?!-country vtt)|kilom[eè]tre vertical|course [aà] pied|course p[ée]destre|hors stade/i;
// A bike, dog, walk or kids' course, whatever its type says ("VTT trail", "Cani-cross", "Trail enfants").
const NOT_RUN = /\bvtt\b|v[ée]lo|bike|cani|marche|rando|enfant|kid|jeune|poussin|benjamin|crossfit/i;
const TYPE_KM = { "semi marathon": 21.1, "semi-marathon": 21.1, marathon: 42.2 };
const CANCELLED = /\bannul[ée]e?\b/i;

/** Only the event URLs of the sitemap: it also lists results and static pages. */
export function discover(sitemapXml, sinceIso) {
  const out = [];
  for (const m of sitemapXml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = m[1].match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim().replace(/&amp;/g, "&");
    const lastmod = m[1].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1] ?? "";
    if (!loc || !/\/epreuve\.php\?id_epreuve=\d+$/.test(loc)) continue;
    if (!sinceIso || !lastmod || lastmod.slice(0, 10) >= sinceIso) out.push({ url: loc, lastmod });
  }
  return out;
}

const decode = (s) =>
  String(s)
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** The page's courses: the panel title ("Trail des Salines 23Km, 1500 D+") and its type ("Trail"). */
export function courses(html) {
  return [...html.matchAll(/href="#parcours-\d+">([\s\S]*?)<\/a>[\s\S]*?Distance :<\/strong>\s*<span[^>]*>([^<]*)</g)].map(
    (m) => ({ name: decode(m[1]), type: decode(m[2]) }),
  );
}

/** One candidate from an event page, or null when it carries no event. */
export function parse(html, url) {
  const ev = jsonLdBlocks(html).find((b) => b["@type"] === "SportsEvent");
  if (!ev?.name || !ev.startDate) return null;
  const runs = courses(html).filter(
    (c) => RUN_TYPE.test(c.type) && !NOT_RUN.test(`${c.type} ${c.name}`) && !CANCELLED.test(c.name),
  );
  const distances = runs.flatMap((c) => {
    const km = parseDistances(c.name, { explicitWins: true });
    return km.length ? km : (TYPE_KM[c.type.toLowerCase()] ?? []);
  });
  const address = ev.location?.address ?? {};
  return {
    source: id,
    sourceKey: url.match(/id_epreuve=(\d+)/)?.[1] ?? url,
    url,
    firstHand,
    name: decode(ev.name),
    date: String(ev.startDate).slice(0, 10),
    endDate: String(ev.endDate ?? ev.startDate).slice(0, 10),
    city: decode(address.addressLocality ?? ""),
    // The département number ("09"), which the commune lookup narrows on.
    region: String(address.addressRegion ?? "").trim(),
    country: countryCode(address.addressCountry),
    lat: null,
    lng: null,
    distances: [...new Set(distances)].sort((a, b) => a - b),
    running: runs.length > 0,
    sport: runs.map((c) => c.type.toLowerCase()).join(", "),
    status: STATUS[String(ev.eventStatus ?? "").split("/").pop()] ?? "scheduled",
    organiserUrl: "",
    text: runs.map((c) => c.name).join(" | "),
  };
}

// The commune API matches official names: "St Girons" is "Saint-Girons".
const officialName = (city) =>
  city
    .replace(/\bste\b\.?/gi, "Sainte")
    .replace(/\bst\b\.?/gi, "Saint")
    .replace(/\s+/g, " ")
    .trim();

/** The commune search for a candidate's town, or null when there is nothing to look up. */
export function communeQuery(c) {
  if (c.country !== "FR" || !c.city) return null;
  const params = new URLSearchParams({ nom: officialName(c.city), fields: "nom,centre,codeDepartement", boost: "population", limit: "10" });
  if (/^(?:\d{2,3}|2[AB])$/i.test(c.region)) params.set("codeDepartement", c.region.toUpperCase());
  return `https://${GEO_HOST}/communes?${params}`;
}

const key = (s) => stripAccents(s).toLowerCase().replace(/[^a-z]+/g, " ").trim();

/** The commune's centre, only when exactly one commune bears the town's name; else null. */
export function pickCommune(results, city) {
  const want = key(officialName(city));
  const same = (Array.isArray(results) ? results : []).filter((r) => key(r?.nom ?? "") === want);
  // Without a département, Saint-Denis (93) and Saint-Denis (974) both answer: no guess.
  const hit = same.length === 1 ? same[0] : null;
  const [lng, lat] = hit?.centre?.coordinates ?? [];
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}
