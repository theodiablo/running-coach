// Find a Race (UK listings and entries, some Irish and European races): sitemaps
// for discovery, the event page's schema.org SportsEvent for extraction. Organisers
// list their own races but many enter elsewhere, so dates count as second-hand.
import { countryCode, jsonLdBlocks, parseDistances } from "../text.mjs";
export { discover } from "./rockthesport.mjs";

export const id = "findarace";
export const firstHand = false;
const BASE = "https://findarace.com";
// "current": one URL per event, showing its next edition; "future": the editions after that.
export const SITEMAPS = ["events-current", "events-future"].map((s) => `${BASE}/sitemap/${s}.xml`);

const STATUS = { EventCancelled: "cancelled", EventPostponed: "postponed", EventScheduled: "scheduled" };
// The breadcrumb's sport, or its kind of race when that comes first ("Half Marathon").
const OTHER_SPORT = /athlon|\b(?:swim|cycl|sportive|bike|obstacle|ocr|walk|hik|paddle|kayak|rowing|ski)/i;
const RUN = /\brun/i;
const SPONSOR = /\s+(?:presented|powered|sponsored) by\b.*$|\s+in association with\b.*$/i;

// A UK postcode, alone or after the town ("East Molesey KT8 9BN"); an Eircode ("D01 F5P2").
// Some are cut short ("DH1 3").
const POSTCODE = /(?:^|\s+)(?:[A-Z]{1,2}\d[A-Z\d]?(?:\s*\d[A-Z]{0,2})?|[A-Z]\d{2}\s?[A-Z\d]{4})$/i;

// A UK nation or county is never the town ("Ware, Hertfordshire, SG12 9AA", "…, Seaford, England").
const REGION = new RegExp(
  "^(?:(?:north|south|east|west|n|s|e|w|greater|mid)\\.?\\s+)?(?:england|scotland|wales|northern ireland|" +
    "\\S*shire|surrey|kent|essex|sussex|norfolk|suffolk|devon|cornwall|dorset|somerset|cumbria|northumberland|" +
    "rutland|middlesex|merseyside|greater london|greater manchester|tyne and wear|midlands|yorkshire|isle of wight|gwynedd|powys|" +
    "conwy|ceredigion|fife|highland|co\\.?\\s+\\S+|county\\s+\\S+)$",
  "i",
);

/** Town and country of a free-text address ("Graves Park, Sheffield, S8 8LL, United Kingdom"). */
export function addressParts(address) {
  const parts = String(address ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return { city: "", country: "" };
  const country = countryCode(parts.at(-1));
  // The town sits with the postcode ("East Molesey KT8 9BN") or before it, counties aside.
  const rest = country ? parts.slice(0, -1) : parts;
  const withCode = rest.findIndex((p) => POSTCODE.test(p));
  const before = (withCode >= 0 ? rest.slice(0, withCode + 1) : rest).map((p) => p.replace(POSTCODE, "").trim());
  const towns = before.filter((p) => p && !REGION.test(p));
  return { city: towns.at(-1) ?? "", country };
}

/** One candidate from an event page, or null when it carries no event. */
export function parse(html, url) {
  const blocks = jsonLdBlocks(html);
  const ev = blocks.find((b) => b["@type"] === "SportsEvent");
  if (!ev?.name || !ev.startDate) return null;
  const crumbs = blocks.find((b) => b["@type"] === "BreadcrumbList")?.itemListElement ?? [];
  // Home › sport › kind › event; a two-step trail (Home › event) names no sport.
  const sport = crumbs.length > 2 ? String(crumbs.find((c) => c.position === 2)?.name ?? "") : "";
  const offers = [].concat(ev.offers ?? []).map((o) => String(o?.name ?? "")).filter(Boolean);
  const name = String(ev.name).replace(SPONSOR, "").trim();
  const place = ev.location ?? {};
  const address = typeof place.address === "string" ? place.address : (place.address?.streetAddress ?? "");
  const lat = Number(place.geo?.latitude);
  const lng = Number(place.geo?.longitude);
  const online = /Online/.test(String(ev.eventAttendanceMode ?? ""));
  const where = addressParts(address);
  // Offer names carry the distances ("Half Marathon", "TrailFest - 50k"), else the name, else the description.
  const labels = [...offers, name];
  let distances = labels.flatMap((l) => parseDistances(l, { explicitWins: true }));
  if (!distances.length) distances = parseDistances(ev.description);
  return {
    source: id,
    // The event's slug: its next edition and later ones sit at /events/<slug> and /events/<slug>/<date>.
    sourceKey: (url.split("/events/")[1] ?? url).split("/")[0],
    url,
    firstHand,
    name,
    date: String(ev.startDate).slice(0, 10),
    endDate: String(ev.endDate ?? ev.startDate).slice(0, 10),
    city: where.city || String(place.name ?? "").split(",")[0].trim(),
    region: "",
    country: where.country || countryCode(place.address?.addressCountry?.name ?? place.address?.addressCountry),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    distances: [...new Set(distances)].sort((a, b) => a - b),
    running: (RUN.test(sport) || !OTHER_SPORT.test(sport)) && !online,
    sport: online ? "virtual" : sport.toLowerCase(),
    status: STATUS[String(ev.eventStatus ?? "").split("/").pop()] ?? "scheduled",
    // The organizer link is the organiser's Find a Race page, not their own site.
    organiserUrl: "",
    text: labels.join(" | "),
  };
}
