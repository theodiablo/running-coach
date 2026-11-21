// running.life (aggregator: France, UK, Ireland, Spain). Discovery walks the
// per-country calendar, 20 schema.org events a page, soonest first. Dates are
// second-hand, so nothing from here is ever auto-published.
import { countryCode, jsonLdBlocks, parseDistances } from "../text.mjs";

export const id = "runninglife";
export const firstHand = false;
const BASE = "https://running.life";
export const COUNTRY_SLUGS = { ES: "spain", FR: "france", GB: "united-kingdom", IE: "ireland" };

export const listingUrl = (country, page) =>
  `${BASE}/running-calendar/${COUNTRY_SLUGS[country]}${page > 1 ? `?page=${page}` : ""}`;

const STATUS = { EventCancelled: "cancelled", EventPostponed: "postponed", EventScheduled: "scheduled" };

function candidate(ev) {
  const geo = ev.location?.geo ?? {};
  const address = ev.location?.address ?? {};
  const lat = Number(geo.latitude);
  const lng = Number(geo.longitude);
  const text = `${ev.name} | ${ev.description ?? ""}`;
  return {
    source: id,
    sourceKey: String(ev.url ?? "").split("/event/")[1] ?? ev.url,
    url: ev.url,
    firstHand,
    name: String(ev.name).trim(),
    date: String(ev.startDate).slice(0, 10),
    endDate: String(ev.endDate ?? ev.startDate).slice(0, 10),
    city: address.addressLocality ?? ev.location?.name ?? "",
    region: address.addressRegion ?? "",
    country: countryCode(address.addressCountry),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    distances: parseDistances(text),
    running: true,
    sport: "running",
    status: STATUS[String(ev.eventStatus ?? "").split("/").pop()] ?? "scheduled",
    organiserUrl: "",
    text,
  };
}

/** The events on one calendar page, and how many pages the calendar has. */
export function parseListing(html) {
  const list = jsonLdBlocks(html).find((b) => b["@type"] === "ItemList");
  const events = (list?.itemListElement ?? [])
    .map((li) => li.item)
    .filter((ev) => ev?.["@type"] === "SportsEvent" && ev.name && ev.startDate && ev.url)
    .map(candidate);
  const pages = [...html.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
  return { events, lastPage: Math.max(1, ...pages) };
}

/** What only the event page has: the full description and the organiser link. */
export function parseEvent(html) {
  const ev = jsonLdBlocks(html).find((b) => b["@type"] === "SportsEvent");
  const tag = html.match(/<a\b[^>]*data-out="website"[^>]*>/)?.[0] ?? "";
  return {
    description: ev?.description ?? "",
    organiserUrl: tag.match(/href="([^"]+)"/)?.[1] ?? "",
  };
}
