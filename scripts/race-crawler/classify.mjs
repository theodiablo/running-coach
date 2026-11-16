// Matching a crawled candidate to the catalogue, and the curated policy that
// decides what is worth proposing. Pure. docs/race-crawler.md.
import { distinctiveTokens, haversineKm, hostOf, nameTokens, parseDistances, stripAccents } from "./text.mjs";

export const POLICY = {
  minKm: 10, // nothing shorter is ever proposed
  minNewRaceKm: 21.1, // a race the catalogue lacks needs a half marathon or longer…
  minNewRaceKmSecondHand: 42.2, // …and a marathon or longer when only an aggregator lists it
  nearKm: 30, // city-level pins sit kilometres from a hand-placed start
  dateChangeDays: 75, // same edition moved, vs next year's edition
  horizonDays: 550,
};

// A shared registration platform says nothing about which race it is.
const PLATFORM_HOSTS = /rockthesport|running\.life|facebook|instagram|njuko|evententry|eventbrite|letsdothis/;

const jaccard = (a, b) => {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((t) => B.has(t)).length;
  return inter ? inter / (A.size + B.size - inter) : 0;
};

// Spelling variants of one place are one word: Castelló / Castellón, Donosti / Donostia.
const sameWord = (a, b) => a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a)));

const containment = (a, b) => {
  if (!a.length || !b.length) return null;
  const A = [...new Set(a)];
  const B = [...new Set(b)];
  return A.filter((t) => B.some((u) => sameWord(t, u))).length / Math.min(A.length, B.length);
};

// A trail race and a road race of the same town are different races (Snowdonia Trail Marathon vs Marathon Eryri).
const TRAIL_WORDS = /\b(?:trail|mountain|montana|muntanya|mendi|sky|skyrace|ultra|fell|cxm|xtreme)/;
const isTrail = (name) => TRAIL_WORDS.test(stripAccents(name).toLowerCase());

const HALF_WORDS = /\b(?:media|medio|mitja|semi|half|meia)\b/;
const MARATHON_WORDS = /\b(?:maraton|marathon|marato|maratona)\b/;
function raceKind(name) {
  const n = stripAccents(name).toLowerCase();
  if (!MARATHON_WORDS.test(n)) return "";
  return HALF_WORDS.test(n) ? "half" : "marathon";
}

// 5%: a trail "marathon" is rarely 42.2 km to the metre.
export const sameDistance = (a, b) => Math.abs(a - b) <= Math.max(0.5, a * 0.05);

function score(candidate, race) {
  if (candidate.country && race.country && candidate.country !== race.country) return null;
  const hasGeo = candidate.lat != null && race.lat != null;
  const km = hasGeo ? haversineKm(candidate.lat, candidate.lng, race.lat, race.lng) : null;
  if (km != null && km > POLICY.nearKm) return null;
  const sameCity =
    !!candidate.city && nameTokens(candidate.city).join(" ") === nameTokens(race.city ?? "").join(" ");
  if (km == null && !sameCity) return null;
  const distanceOk =
    !candidate.distances.length ||
    !race.distances?.length ||
    candidate.distances.some((d) => race.distances.some((r) => sameDistance(d, r)));
  if (!distanceOk) return null;
  const roadKind = (n) => !!raceKind(n) && !isTrail(n);
  if ((isTrail(candidate.name) && roadKind(race.name)) || (roadKind(candidate.name) && isTrail(race.name))) return null;
  const host = hostOf(candidate.organiserUrl);
  const hostMatch = !!host && !PLATFORM_HOSTS.test(host) && host === hostOf(race.url);
  const all = jaccard(nameTokens(candidate.name), nameTokens(race.name));
  // A shared town name is not a shared race: "Carrera de la Prensa Málaga" is not the Málaga marathon.
  const towns = new Set([...nameTokens(candidate.city), ...nameTokens(race.city ?? "")]);
  const own = (name) => distinctiveTokens(name).filter((t) => ![...towns].some((w) => sameWord(t, w)));
  const mine = own(candidate.name);
  const theirs = own(race.name);
  // A bare "<kind> <town>" name is the same race as that kind in that town, sponsor prefix or not
  // ("Dublin Marathon" is the "Irish Life Dublin Marathon"), but only when the kinds and distances agree.
  const kind = raceKind(candidate.name);
  // …and in the same town: the Orihuela half is not the Elche half 25 km away.
  const raceTown = nameTokens(race.city ?? "");
  const candidateWords = [...nameTokens(candidate.name), ...nameTokens(candidate.city)];
  const sameTown =
    (km != null && km <= 5) ||
    (raceTown.length > 0 && raceTown.every((t) => candidateWords.some((w) => sameWord(t, w))));
  const bare =
    (!mine.length || !theirs.length) &&
    sameTown &&
    !!kind &&
    kind === raceKind(race.name) &&
    candidate.distances.length > 0 &&
    race.distances?.length > 0;
  // The catalogue may carry a sponsor the source drops, never the reverse: a source name with words
  // of its own ("Cardiff Half Winter Warmer Run") is a different event until a person says otherwise.
  const name = bare ? (mine.length ? 0.4 : 0.6) : (containment(mine, theirs) ?? 0);
  return { slug: race.slug, hostMatch, all, name, km };
}

/**
 * Which catalogue race a candidate is, if any.
 * @returns {{kind:"match"|"ambiguous"|"none", slug?:string, why:string}}
 */
export function matchRace(candidate, races) {
  const scored = races.map((r) => score(candidate, r)).filter(Boolean);
  const byHost = scored.filter((s) => s.hostMatch);
  // A sister event (the breakfast run of a marathon) shares the organiser's site, so the name must agree too.
  if (byHost.length === 1 && byHost[0].name >= 0.34) {
    return { kind: "match", slug: byHost[0].slug, why: "organiser site" };
  }
  const strong = scored.filter((s) => s.name >= 0.6).sort((a, b) => b.all - a.all);
  // With no distance to agree on, a name alone ("Hivernale des Templiers") can be a sister event.
  if (strong.length && !candidate.distances.length) {
    return { kind: "ambiguous", slug: strong[0].slug, why: "no distance to confirm" };
  }
  if (strong.length === 1 || (strong.length > 1 && strong[0].all - strong[1].all >= 0.15)) {
    return { kind: "match", slug: strong[0].slug, why: `name ${strong[0].all.toFixed(2)}` };
  }
  if (strong.length > 1) {
    return { kind: "ambiguous", slug: strong[0].slug, why: `also ${strong[1].slug}` };
  }
  const weak = scored.filter((s) => s.name >= 0.34).sort((a, b) => b.all - a.all);
  if (weak.length) return { kind: "ambiguous", slug: weak[0].slug, why: `weak name ${weak[0].all.toFixed(2)}` };
  return { kind: "none", why: "" };
}

const dayMs = 86_400_000;
const isRealDate = (d) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / dayMs);
const WEEKEND = new Set([0, 6]);
const VIRTUAL_RE = /\bvirtual\b/i;
const TBC_RE = /\b(?:tbc|tba|to be (?:confirmed|announced)|provisional|a confirmar|por confirmar|pendiente de confirmar)\b|à confirmer/i;
const NOT_A_RUN_RE = /\b(?:duatl|triatl|duathl|triathl|aquatl|swimrun|canicross|run\s*(?:and|&)\s*bike|bike|v[eé]lo|btt|mtb|marcha|marxa|caminada|senderis|randonn|rando\b|walk|hyrox|swimmer|training event|entreno)/i;

/**
 * The verdict on one candidate.
 * @returns {{verdict:string, slug?:string, distances:number[], flags:string[], why:string, previousDate?:string}}
 * verdict: newEdition | dateChange | newRace | review (propose) · known | dropped
 */
export function classify(candidate, catalogue, today) {
  const flags = [];
  const drop = (why) => ({ verdict: "dropped", why, distances: [], flags });
  if (!candidate.running) return drop("not running");
  if (candidate.status === "cancelled") return drop("cancelled");
  if (VIRTUAL_RE.test(`${candidate.name} ${candidate.text ?? ""}`)) return drop("virtual");
  if (NOT_A_RUN_RE.test(candidate.name)) return drop("not running");
  // An impossible date (2027-02-30) would roll over here and abort the write at Postgres's date cast.
  if (!isRealDate(candidate.date)) return drop("invalid date");
  const ahead = daysBetween(today, candidate.date);
  if (!(ahead >= 0)) return drop("past");
  if (ahead > POLICY.horizonDays) return drop("too far ahead");
  // A page's fares can belong to the whole event: a name that states its own distance wins.
  const named = parseDistances(candidate.name);
  if (named.length) candidate = { ...candidate, distances: named };
  const distances = candidate.distances.filter((d) => d >= POLICY.minKm);
  if (candidate.distances.length && !distances.length) return drop("under 10 km");

  if (candidate.status === "postponed") flags.push("postponed");
  // A source's date is the event's first day; the race itself can be on any of them (Snowdonia: 10K Saturday, marathon Sunday).
  if (candidate.endDate && candidate.endDate > candidate.date) flags.push("multi-day");
  if (TBC_RE.test(`${candidate.name} ${candidate.text ?? ""}`)) flags.push("tbc");
  if (!candidate.country) flags.push("no country");
  if (candidate.lat == null) flags.push("no coordinates");
  if (!distances.length) flags.push("distance unknown");
  if (!candidate.firstHand) flags.push("second-hand date");
  if (!WEEKEND.has(new Date(`${candidate.date}T00:00:00Z`).getUTCDay())) flags.push("weekday");

  const match = matchRace(candidate, catalogue.races);
  if (match.kind === "none") {
    if (!distances.length) return drop("distance unknown");
    const longest = Math.max(...distances);
    if (longest < POLICY.minNewRaceKm) return drop("new race under half marathon");
    return { verdict: "newRace", distances, flags, why: "", minor: !candidate.firstHand && longest < POLICY.minNewRaceKmSecondHand };
  }
  if (match.kind === "ambiguous") return { verdict: "review", slug: match.slug, distances, flags, why: match.why };

  const editions = catalogue.editions.filter((e) => e.race_slug === match.slug);
  if (editions.some((e) => e.date === candidate.date)) {
    return { verdict: "known", slug: match.slug, distances, flags, why: match.why };
  }
  const moved = editions.find(
    (e) => e.date >= today && Math.abs(daysBetween(e.date, candidate.date)) <= POLICY.dateChangeDays,
  );
  if (moved) {
    return { verdict: "dateChange", slug: match.slug, distances, flags, why: match.why, previousDate: moved.date };
  }
  return { verdict: "newEdition", slug: match.slug, distances, flags, why: match.why };
}

/** Fold the same event seen in two sources into one proposal, first-hand source first. */
export function mergeSources(proposals) {
  const out = [];
  const sorted = [...proposals].sort((a, b) => Number(b.candidate.firstHand) - Number(a.candidate.firstHand));
  for (const p of sorted) {
    const c = p.candidate;
    const twin = out.find((o) => {
      const k = o.candidate;
      if (k.source === c.source || k.date !== c.date) return false;
      if (p.slug && o.slug) return p.slug === o.slug;
      if (c.lat == null || k.lat == null) return false;
      if (haversineKm(c.lat, c.lng, k.lat, k.lng) > POLICY.nearKm) return false;
      return (containment(distinctiveTokens(c.name), distinctiveTokens(k.name)) ?? 0) >= 0.6;
    });
    if (twin) twin.alsoIn = [...(twin.alsoIn ?? []), { source: c.source, url: c.url }];
    else out.push({ ...p });
  }
  return out;
}

/** A sub-marathon new race only an aggregator lists is not worth a maintainer's look. */
export const worthProposing = (p) => !p.minor || !!p.alsoIn;
