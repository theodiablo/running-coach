// Turns the crawler's proposals into catalogue rows (always verified = false)
// and ledger rows (race_crawl_items). Pure, except `runSql`. docs/race-crawler.md.
import { randomBytes } from "node:crypto";
import { hostOf, stripAccents } from "./text.mjs";

// Anything flagged one of these waits for a person, whatever its verdict.
const BLOCKING = new Set(["no country", "no coordinates", "distance unknown", "weekday", "postponed", "tbc"]);
const PLATFORM_URL = /running\.life|facebook\.com|instagram\.com/;
const sameDistance = (a, b) => Math.abs(a - b) <= Math.max(0.5, a * 0.03);

export function slugify(s) {
  return stripAccents(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const ROMAN = /^(?=[ivxlc]+\b)c{0,3}(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})\b\.?\s+/i;
const ORDINAL = /^\d{1,3}(?:ª|º|e|eme|ème|th|st|nd|rd|\.)?\s+(?=\p{L})/u;

/** The race's own name: no edition number, no year, not shouting. */
export function cleanName(name) {
  let n = String(name).trim().replace(/\s+/g, " ");
  n = n.replace(ROMAN, "").replace(ORDINAL, "");
  n = n.replace(/[\s,–-]*\b(?:19|20)\d\d(?:\/\d{2,4})?\s*$/, "").replace(/[\s–-]+$/, "");
  if (n === n.toUpperCase() && /\p{L}{4}/u.test(n)) {
    n = n.toLowerCase().replace(/(^|[\s(-])(\p{L})/gu, (m, sep, c) => sep + c.toUpperCase());
  }
  return n.slice(0, 120);
}

function headlineDistance(name, distances) {
  const n = stripAccents(name).toLowerCase();
  const has = (km) => distances.find((d) => sameDistance(d, km));
  if (/\b(?:media|medio|mitja|semi|half|meia)\b/.test(n) && has(21.1)) return has(21.1);
  if (/\b(?:maraton|marathon|marato|maratona)\b/.test(n) && has(42.2)) return has(42.2);
  return Math.max(...distances);
}

function freeSlug(base, taken) {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/**
 * What to write for one proposal: the ledger row, plus a race and/or edition
 * when it can go in without a person. `taken` holds race slugs and edition ids
 * already in use, and is updated.
 */
export function plan(p, catalogue, taken) {
  const c = p.candidate;
  const ledger = {
    source: c.source,
    source_key: c.sourceKey,
    date: c.date,
    verdict: p.verdict,
    status: "review",
    race_slug: p.slug ?? null,
    edition_id: null,
    url: c.url,
    candidate: { ...c, distances: p.distances, flags: p.flags, why: p.why, previousDate: p.previousDate, alsoIn: p.alsoIn },
    note: null,
  };
  const waits = (note) => ({ ledger: { ...ledger, note } });
  const blocking = p.flags.filter((f) => BLOCKING.has(f));
  if (p.verdict === "dateChange") return waits(`catalogue has ${p.previousDate}`);
  if (p.verdict === "review") return waits(p.why);
  if (blocking.length) return waits(blocking.join(", "));
  if (p.verdict === "newRace" && !c.firstHand && !p.alsoIn) return waits("one aggregator only");

  if (p.verdict === "newEdition") {
    const race = catalogue.races.find((r) => r.slug === p.slug);
    const km = (race?.distances ?? []).find((d) => p.distances.some((x) => sameDistance(x, d)));
    if (km == null) return waits("no distance in common with the catalogue race");
    const id = freeSlug(`${p.slug}-${c.date}`, taken);
    taken.add(id);
    const edition = { id, race_slug: p.slug, date: c.date, distance_km: km };
    return { ledger: { ...ledger, status: "inserted", edition_id: id }, edition };
  }

  const name = cleanName(c.name);
  const km = headlineDistance(name, p.distances);
  const city = String(c.city ?? "").split(",").pop().trim().slice(0, 80);
  const slug = freeSlug(slugify(name) || "race", taken);
  taken.add(slug);
  const id = `${slug}-${c.date}`;
  taken.add(id);
  const organiser = c.organiserUrl && !PLATFORM_URL.test(hostOf(c.organiserUrl)) ? c.organiserUrl : "";
  const url = (organiser || (c.firstHand ? c.url : "")).slice(0, 300) || null;
  const race = { slug, name, city, country: c.country, lat: c.lat, lng: c.lng, distances: [km], url };
  const edition = { id, race_slug: slug, date: c.date, distance_km: km };
  return { ledger: { ...ledger, status: "inserted", race_slug: slug, edition_id: id }, race, edition };
}

/** One idempotent statement writing every row; the data rides a dollar-quoted JSON literal. */
export function buildSql({ races, editions, ledger }) {
  const json = JSON.stringify({ races, editions, ledger });
  let tag;
  do tag = `crawl_${randomBytes(6).toString("hex")}`;
  while (json.includes(tag));
  const data = `$${tag}$${json}$${tag}$::jsonb`;
  return `
with data as (select ${data} as d),
new_races as (
  insert into public.races (slug, name, city, country, lat, lng, distances, url, verified, created_by)
  select r.slug, r.name, nullif(r.city, ''), r.country, r.lat, r.lng, r.distances, r.url, false, null
  from data, jsonb_to_recordset(d->'races')
    as r(slug text, name text, city text, country text, lat double precision, lng double precision, distances jsonb, url text)
  on conflict do nothing
  returning slug
),
new_editions as (
  insert into public.race_editions (id, race_slug, date, distance_km, elevation, verified, created_by)
  select e.id, e.race_slug, e.date, e.distance_km, 0, false, null
  from data, jsonb_to_recordset(d->'editions') as e(id text, race_slug text, date date, distance_km double precision)
  -- A new race's edition only goes in with its race, never onto a race that already had the slug.
  where exists (select 1 from new_races n where n.slug = e.race_slug)
     or (not exists (select 1 from jsonb_to_recordset(d->'races') as r(slug text) where r.slug = e.race_slug)
         and exists (select 1 from public.races x where x.slug = e.race_slug))
  on conflict do nothing
  returning id
),
ledger as (
  insert into public.race_crawl_items (source, source_key, date, verdict, status, race_slug, edition_id, url, candidate, note)
  select l.source, l.source_key, l.date, l.verdict, l.status, l.race_slug, l.edition_id, l.url, l.candidate, l.note
  from data, jsonb_to_recordset(d->'ledger')
    as l(source text, source_key text, date date, verdict text, status text, race_slug text,
         edition_id text, url text, candidate jsonb, note text)
  on conflict (source, source_key, date) do update set last_seen = current_date
  returning 1
)
select (select count(*) from new_races) as races,
       (select count(*) from new_editions) as editions,
       (select count(*) from ledger) as ledger;`;
}

/** The ledger keys already written, so nothing is proposed twice. */
export const LEDGER_KEYS_SQL =
  "select source || ':' || source_key || ':' || date::text as key from public.race_crawl_items";

export const ledgerKey = (c) => `${c.source}:${c.sourceKey}:${c.date}`;

/** Runs SQL through the Supabase Management API (the same door as scripts/supabase-query.sh). */
export async function runSql(sql, { projectRef, accessToken }) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.ok) return res.json();
    const body = await res.text();
    if (attempt >= 3 || res.status < 500) throw new Error(`Supabase query failed (HTTP ${res.status}): ${body}`);
    await new Promise((r) => setTimeout(r, attempt * 3000));
  }
}
