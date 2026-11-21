// Turns the crawler's proposals into catalogue rows (always verified = false)
// and ledger rows (race_crawl_items). Pure, except `runSql`. docs/race-crawler.md.
import { randomBytes } from "node:crypto";
import { isTrail, sameDistance } from "./classify.mjs";
import { countryCode, hostOf, isSeriesPart, stripAccents } from "./text.mjs";

// Anything flagged one of these waits for a person, whatever its verdict.
const BLOCKING = new Set([
  "no country",
  "no coordinates",
  "distance unknown",
  "weekday",
  "postponed",
  "tbc",
  "multi-day",
  "date not confirmed by the page",
]);
// Hosts that serve many races (aggregators, social networks, timing companies): never a race's own page.
const PLATFORM_URL = /running\.life|facebook\.com|instagram\.com|mychip\.es|gesconchip\.es|ocisport\.net/;

export function slugify(s) {
  return stripAccents(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const ROMAN = /^(?=[ivxlc]+\b)c{0,3}(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})\b\.?\s+/i;
// "IV-Domusa" is an edition number; a lone letter before a hyphen is a name ("X-Trail", "I-Run").
const ROMAN_DASH = /^(?=[ivxlc]{2,}\b)c{0,3}(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})\b\.?\s*[-–]\s*/i;
const ORDINAL = /^\d{1,3}(?:ª|º|°|a|e|èmes|emes|eme|ème|th|st|nd|rd|er|do|ro|to|mo|vo|no|\.)?\s+(?!k\b|km\b)(?=\p{L})/u;
// "(7ème édition)", "- 4ème édition", "7ª edición", "7th edition", "édition 12", anywhere in the name.
const EDITION =
  /\s*[(–-]?\s*(?:\d{1,3}\s*(?:ª|º|°|e|è|ème|eme|th|st|nd|rd|er|a)\.?\s*(?:é|e)di[tc]i[oó]n|(?:é|e)dition\s+\d{1,3})\s*\)?/giu;
// A sponsor in capitals at the end ("Urban Trail CHUT By GROUPAMA"); "Run by the Sea" keeps its words.
const SPONSOR_TAIL = /\s+(?:[Pp]resented\s+|[Pp]owered\s+)?(?:by|By|BY)\s+[\p{Lu}\d&' -]{3,}$/u;
const SMALL = new Set("de del la las los el i y e et du des le les the of and a al en".split(" "));

function titleCase(s) {
  return s
    .toLowerCase()
    .replace(/[\p{L}\d]+/gu, (w, at) => {
      if (at > 0 && SMALL.has(w)) return w;
      // No vowel, so an acronym: JJP, GTF, BP.
      if (!/[aeiouyàáâèéêìíîòóôùúûü\d]/.test(w)) return w.toUpperCase();
      return w[0].toUpperCase() + w.slice(1);
    });
}

const mostlyCaps = (s) => {
  const letters = s.replace(/[^\p{L}]/gu, "");
  return letters.length >= 4 && letters.replace(/\p{Lu}/gu, "").length / letters.length < 0.3;
};

/** The race's own name: no edition number, year or series tag, not shouting. */
export function cleanName(name, date = "") {
  const yy = date.slice(2, 4);
  const parts = String(name)
    .split(",")
    .map((p) =>
      p
        .trim()
        .replace(/\s+/g, " ")
        .replace(/\b(?:19|20)\d\d(?:\/\d{2,4})?\b/g, "")
        .replace(yy ? new RegExp(`\\s${yy}$`) : /$^/, "")
        .replace(/[\s.–-]+$/, "")
        .trim(),
    )
    .filter((p, i) => p && !isSeriesPart(p, i));
  const joined = parts
    .join(", ")
    .replace(EDITION, " ")
    .replace(/\s*(?:[–-]\s*)?(?:é|e)dition$/iu, "")
    .trim();
  let n = joined.replace(ROMAN_DASH, "").replace(ROMAN, "").replace(ORDINAL, "");
  // "36èmes foulées…" leaves a lower-case word at the front.
  if (n !== joined) n = n.charAt(0).toUpperCase() + n.slice(1);
  if (mostlyCaps(n)) n = titleCase(n);
  else n = n.replace(SPONSOR_TAIL, "");
  n = n.replace(/\s+/g, " ").replace(/[\s.,–-]+$/, "").trim();
  return n.slice(0, 120);
}

/** An absolute http(s) URL (races_url_web_only), or null. */
export function webUrl(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
    return /^https?:$/.test(u.protocol) && u.href.length <= 300 ? u.href : null;
  } catch {
    return null;
  }
}

/** A display city: the locality, no street or postcode, never the country. */
export function cleanCity(city, country) {
  let c = String(city ?? "").split(",").pop().replace(/^\s*\d{4,5}\s+/, "").trim();
  if (countryCode(c) && countryCode(c) === country) c = "";
  if (mostlyCaps(c)) c = titleCase(c);
  return c.slice(0, 80);
}

function headlineDistance(name, distances) {
  const n = stripAccents(name).toLowerCase();
  const has = (km) => distances.find((d) => sameDistance(d, km));
  if (/\b(?:media|medio|mitja|semi|half|meia)\b/.test(n) && has(21.1)) return has(21.1);
  if (/\b(?:maraton|marathon|marato|maratona)\b/.test(n) && has(42.2)) return has(42.2);
  return Math.max(...distances);
}

// Mountain races the matcher's trail words miss: a word ending in "trail" (Santkutrail), Basque
// mendi lasterketa after its length ("15 MLK"; a bare MLK is Martin Luther King Day), a GR path, "Xtrem".
const TRAIL_TERRAIN = /trail\b|(?:^|\D)\d{1,3}\s*mlk\b|\bgr[ -]?\d{1,4}\b|\bxtrem\b/;
const trailTerrain = (name) => isTrail(name) || TRAIL_TERRAIN.test(stripAccents(name).toLowerCase());

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
  // Not a person's job: it goes in by itself once a second source lists it, and its flags are checked then.
  if (p.verdict === "newRace" && !c.firstHand && !p.alsoIn) {
    return { ledger: { ...ledger, status: "waiting", note: "one aggregator only" } };
  }
  if (blocking.length) return waits(blocking.join(", "));

  // An aggregator lists next year's edition before the organiser has a date (Toulouse 2027), so its new
  // edition of a known race waits for a person unless a second source agrees.
  if (p.verdict === "newEdition" && !c.firstHand && !p.alsoIn) return waits("one aggregator only");

  if (p.verdict === "newEdition") {
    const race = catalogue.races.find((r) => r.slug === p.slug);
    const km = (race?.distances ?? []).find((d) => p.distances.some((x) => sameDistance(x, d)));
    if (km == null) return waits("no distance in common with the catalogue race");
    const id = freeSlug(`${p.slug}-${c.date}`, taken);
    taken.add(id);
    const edition = { id, race_slug: p.slug, date: c.date, distance_km: km };
    return { ledger: { ...ledger, status: "inserted", edition_id: id }, edition };
  }

  const name = cleanName(c.name, c.date);
  if (!name) return waits("no usable name");
  // A cleaned name the catalogue already has is that race seen under another page, not a new one.
  if (catalogue.races.some((r) => slugify(r.name) === slugify(name))) return waits("a race with this name exists");
  const km = headlineDistance(name, p.distances);
  const city = cleanCity(c.city, c.country);
  const slug = freeSlug(slugify(name) || "race", taken);
  taken.add(slug);
  const id = `${slug}-${c.date}`;
  taken.add(id);
  const organiser = c.organiserUrl && !PLATFORM_URL.test(hostOf(c.organiserUrl)) ? c.organiserUrl : "";
  const url = webUrl(organiser || (c.firstHand ? c.url : ""));
  // The source's own name too: cleaning drops a series tag ("…, Circuit Trail Marina") that says trail.
  const terrain = c.sport === "trail" || trailTerrain(c.name) || trailTerrain(name) ? "trail" : "road";
  const race = { slug, name, city, country: c.country, lat: c.lat, lng: c.lng, distances: [km], url, terrain };
  const edition = { id, race_slug: slug, date: c.date, distance_km: km };
  return { ledger: { ...ledger, status: "inserted", race_slug: slug, edition_id: id }, race, edition };
}

/** One idempotent statement writing every row; the data rides a dollar-quoted JSON literal. */
export function buildSql({ races, editions, ledger }) {
  // Postgres's jsonb refuses \u0000 and lone surrogates: one such scraped string would abort the week's write.
  const json = JSON.stringify({ races, editions, ledger }, (k, v) =>
    typeof v === "string" ? v.replaceAll(String.fromCharCode(0), "").toWellFormed() : v,
  );
  let tag;
  do tag = `crawl_${randomBytes(6).toString("hex")}`;
  while (json.includes(tag));
  const data = `$${tag}$${json}$${tag}$::jsonb`;
  return `
with data as (select ${data} as d),
new_races as (
  insert into public.races (slug, name, city, country, lat, lng, distances, url, terrain, verified, created_by)
  select r.slug, r.name, nullif(r.city, ''), r.country, r.lat, r.lng, r.distances, r.url, r.terrain, false, null
  from data, jsonb_to_recordset(d->'races')
    as r(slug text, name text, city text, country text, lat double precision, lng double precision, distances jsonb, url text, terrain text)
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
  -- A row planned as inserted that the catalogue already had (a contribution landed meanwhile) waits for a person.
  select l.source, l.source_key, l.date, l.verdict,
         case when l.status = 'inserted' and not exists (select 1 from new_editions n where n.id = l.edition_id)
              then 'review' else l.status end,
         l.race_slug, l.edition_id, l.url, l.candidate,
         case when l.status = 'inserted' and not exists (select 1 from new_editions n where n.id = l.edition_id)
              then 'not written: already in the catalogue' else l.note end
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
