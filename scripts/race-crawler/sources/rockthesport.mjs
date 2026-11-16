// Rock the Sport (registration platform, mostly Spain): sitemap for discovery,
// schema.org JSON-LD plus the page's embedded event data for extraction.
// Pages only: robots.txt disallows /api/.
import { countryCode, jsonLdBlocks, parseDistances } from "../text.mjs";

export const id = "rockthesport";
export const firstHand = true;
const BASE = "https://web.rockthesport.com";
// One sitemap per country; the unsuffixed one is Spain.
export const SITEMAPS = ["es", "es-pt", "es-ad", "es-mx", "es-pa"].map((s) => `${BASE}/sitemap/events-${s}.xml`);

const SUBSPORT_KM = { "5km": 5, "10km": 10, "half marathon": 21.1, marathon: 42.2 };
const RUNNING_SPORTS = new Set(["running", "trail"]);

/** Event URLs whose lastmod is on or after `sinceIso` (YYYY-MM-DD). */
export function discover(sitemapXml, sinceIso) {
  const out = [];
  for (const m of sitemapXml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = m[1].match(/<loc>([^<]+)<\/loc>/)?.[1];
    const lastmod = m[1].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1] ?? "";
    if (loc && (!sinceIso || !lastmod || lastmod.slice(0, 10) >= sinceIso)) out.push({ url: loc, lastmod });
  }
  return out;
}

// The Next.js flight payload: JSON strings pushed chunk by chunk.
function flightText(html) {
  let s = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
    try {
      s += JSON.parse(`"${m[1]}"`);
    } catch {
      // Skip a chunk that isn't a plain JSON string.
    }
  }
  return s;
}

function jsonAt(text, re) {
  const m = text.match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

const STATUS = { EventCancelled: "cancelled", EventPostponed: "postponed", EventScheduled: "scheduled" };

/** One candidate from an event page, or null when it carries no event. */
export function parse(html, url) {
  const ev = jsonLdBlocks(html).find((b) => b["@type"] === "SportsEvent");
  if (!ev?.name || !ev.startDate) return null;
  const flight = flightText(html);
  const location = jsonAt(flight, /"location":(\{"city":[^}]*\})/) ?? {};
  const subsports = jsonAt(flight, /"subsports":(\[[^\]]*\])/) ?? [];
  const tariffNames = jsonAt(flight, /"tariffNames":(\{[^}]*\})/) ?? {};
  const sport = String(ev.sport ?? "").toLowerCase();
  const labels = Object.values(tariffNames).join(" | ");
  const fromSubsports = subsports.map((s) => SUBSPORT_KM[s]).filter(Boolean);
  const geo = ev.location?.geo ?? {};
  const lat = Number(geo.latitude ?? location.latitude);
  const lng = Number(geo.longitude ?? location.longitude);
  return {
    source: id,
    sourceKey: url.split("/event/")[1] ?? url,
    url,
    firstHand,
    name: ev.name.trim(),
    date: ev.startDate.slice(0, 10),
    endDate: String(ev.endDate ?? ev.startDate).slice(0, 10),
    city: location.city ?? ev.location?.address?.addressLocality ?? "",
    region: location.province ?? "",
    country: countryCode(location.country),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    distances: [...new Set([...fromSubsports, ...parseDistances(labels)])].sort((a, b) => a - b),
    running: RUNNING_SPORTS.has(sport),
    sport,
    status: STATUS[String(ev.eventStatus ?? "").split("/").pop()] ?? "scheduled",
    organiserUrl: ev.organizer?.url ?? "",
    text: labels,
  };
}
