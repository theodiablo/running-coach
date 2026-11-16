// Find a Race (UK listings and entries, some Irish and European races): sitemaps
// for discovery, the event page's schema.org SportsEvent for extraction. Organisers
// list their own races but many enter elsewhere, so dates count as second-hand.
import { countryCode, jsonLdBlocks, parseDistances } from "../text.mjs";

export const id = "findarace";
export const firstHand = false;
const BASE = "https://findarace.com";
// "current": one URL per event, showing its next edition; "future": the editions after that.
export const SITEMAPS = ["events-current", "events-future"].map((s) => `${BASE}/sitemap/${s}.xml`);

const STATUS = { EventCancelled: "cancelled", EventPostponed: "postponed", EventScheduled: "scheduled" };
// The breadcrumb's sport, or its kind of race when that comes first ("Half Marathon").
const OTHER_SPORT = /athlon|swim|cycl|sportive|bike|obstacle|ocr|walk|hik|paddle|kayak|row|ski/i;
const SPONSOR = /\s+(?:presented|powered|sponsored) by\b.*$|\s+in association with\b.*$/i;

// A UK postcode, alone or after the town ("East Molesey KT8 9BN"); an Eircode ("D01 F5P2").
// Some are cut short ("DH1 3").
const POSTCODE = /(?:^|\s+)(?:[A-Z]{1,2}\d[A-Z\d]?(?:\s*\d[A-Z]{0,2})?|[A-Z]\d{2}\s?[A-Z\d]{4})$/i;

/** Town and country of a free-text address ("Graves Park, Sheffield, S8 8LL, United Kingdom"). */
export function addressParts(address) {
  const parts = String(address ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const country = parts.length > 1 ? countryCode(parts.at(-1)) : "";
  const towns = (country ? parts.slice(0, -1) : parts).map((p) => p.replace(POSTCODE, "").trim()).filter(Boolean);
  return { city: parts.length > 1 ? (towns.at(-1) ?? "") : "", country };
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
    sourceKey: url.split("/events/")[1] ?? url,
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
    running: !OTHER_SPORT.test(sport) && !online,
    sport: online ? "virtual" : sport.toLowerCase(),
    status: STATUS[String(ev.eventStatus ?? "").split("/").pop()] ?? "scheduled",
    // The organizer link is the organiser's Find a Race page, not their own site.
    organiserUrl: "",
    text: labels.join(" | "),
  };
}
