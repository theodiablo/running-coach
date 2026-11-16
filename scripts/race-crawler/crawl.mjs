#!/usr/bin/env node
// Weekly race-catalogue crawler, dry-run: reads the sources and the live
// catalogue, writes a report of what to add. It never writes to the database.
// Usage and policy: docs/race-crawler.md.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { POLICY, classify, mergeSources, worthProposing } from "./classify.mjs";
import { parseDistances } from "./text.mjs";
import { LEDGER_KEYS_SQL, buildSql, ledgerKey, plan, runSql } from "./apply.mjs";
import * as rts from "./sources/rockthesport.mjs";
import * as rl from "./sources/runninglife.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const USER_AGENT = "running-coach-race-crawler/1.0 (weekly; race catalogue)";
const PROPOSED = new Set(["newEdition", "dateChange", "newRace", "review"]);

const { values: args } = parseArgs({
  options: {
    sources: { type: "string", default: "rockthesport,runninglife" },
    countries: { type: "string", default: "ES,FR,GB,IE" },
    "since-days": { type: "string", default: "15" },
    "max-pages": { type: "string", default: "0" },
    "delay-ms": { type: "string", default: "1000" },
    out: { type: "string", default: "race-crawl-report/report" },
    state: { type: "string" },
    apply: { type: "boolean", default: false },
    "sql-out": { type: "string" },
  },
});
const sinceDays = Number(args["since-days"]);
const maxPages = Number(args["max-pages"]);
const delayMs = Number(args["delay-ms"]);
const today = new Date().toISOString().slice(0, 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastHit = new Map();

// Only the sources' own hosts: a URL read off a scraped page is never followed elsewhere.
const SOURCE_HOSTS = new Set(["web.rockthesport.com", "running.life"]);
const onSourceHost = (u) => {
  try {
    return SOURCE_HOSTS.has(new URL(u).host);
  } catch {
    return false;
  }
};

async function get(url) {
  // Redirects are followed by hand, so a request never reaches a host outside the sources.
  for (let hop = 0; hop < 5; hop++) {
    if (!onSourceHost(url)) throw new Error(`off-source URL: ${url}`);
    const res = await fetchOnce(url);
    if (res.redirect) {
      url = new URL(res.redirect, url).href;
      continue;
    }
    return res.body;
  }
  throw new Error(`too many redirects: ${url}`);
}

async function fetchOnce(url) {
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    const wait = (lastHit.get(host) ?? 0) + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
    try {
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        return { redirect: res.headers.get("location") };
      }
      if (res.ok) return { body: await res.text() };
      if (res.status === 404 || res.status === 410) return { body: null };
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt >= 3) throw new Error(`${url}: ${err.message}`, { cause: err });
      await sleep(attempt * 5000);
    }
  }
}

// The anon key is public-safe and has one home: src/config.ts.
function supabaseConfig() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not set (https://<project ref>.supabase.co).");
  const fallback = readFileSync(resolve(ROOT, "src/config.ts"), "utf8").match(/"(sb_publishable_[^"]+)"/)?.[1];
  const key = process.env.SUPABASE_ANON_KEY || fallback;
  if (!key) throw new Error("SUPABASE_ANON_KEY is not set and src/config.ts has no fallback.");
  return { url, key };
}

async function loadCatalogue() {
  const { url, key } = supabaseConfig();
  const table = async (name, select) => {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const query = `select=${select}&order=${select.split(",")[0]}&limit=1000&offset=${from}`;
      const res = await fetch(`${url}/rest/v1/${name}?${query}`, {
        headers: { apikey: key, authorization: `Bearer ${key}` },
      });
      if (!res.ok) throw new Error(`catalogue ${name}: HTTP ${res.status}`);
      const page = await res.json();
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
  };
  const races = await table("races", "slug,name,city,country,lat,lng,distances,url");
  const editions = await table("race_editions", "id,race_slug,date,distance_km");
  return { races, editions };
}

// One page failing costs that page, never the source's whole week; the job still ends red (see main).
async function getPage(url, stats) {
  try {
    return await get(url);
  } catch (err) {
    stats.pageErrors = (stats.pageErrors ?? 0) + 1;
    stats.lastPageError = err.message;
    return null;
  }
}

async function crawlRockTheSport(stats) {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
  const candidates = [];
  for (const sitemap of rts.SITEMAPS) {
    const xml = await get(sitemap);
    if (!xml) continue;
    let urls = rts.discover(xml, since);
    stats.discovered += urls.length;
    if (maxPages) urls = urls.slice(0, maxPages);
    for (const { url } of urls) {
      const html = await getPage(url, stats);
      stats.fetched++;
      const c = html && rts.parse(html, url);
      if (c) candidates.push(c);
      else stats.unparsed++;
    }
  }
  return candidates;
}

async function crawlRunningLife(stats, countries, catalogue, seenKeys) {
  const candidates = [];
  for (const country of countries.filter((c) => rl.COUNTRY_SLUGS[c])) {
    let lastPage = 1;
    for (let page = 1; page <= lastPage && (!maxPages || page <= maxPages); page++) {
      const html = await getPage(rl.listingUrl(country, page), stats);
      stats.fetched++;
      if (!html) break;
      const listing = rl.parseListing(html);
      lastPage = listing.lastPage;
      stats.discovered += listing.events.length;
      if (!listing.events.length) break;
      for (const c of listing.events) {
        // The listing truncates descriptions and has no organiser link: fetch the event page only for survivors.
        // …and only for events not already in the ledger, or the fetches grow every week.
        if (!seenKeys.has(ledgerKey(c)) && PROPOSED.has(classify(c, catalogue, today).verdict)) {
          const detail = await getPage(c.url, stats);
          stats.fetched++;
          if (detail) {
            const { description, organiserUrl } = rl.parseEvent(detail);
            c.organiserUrl = organiserUrl;
            if (description) {
              c.text = `${c.name} | ${description}`;
              c.distances = parseDistances(c.text);
            }
          }
        }
        candidates.push(c);
      }
      const furthest = listing.events.at(-1).date;
      if ((new Date(furthest) - new Date(today)) / 86_400_000 > POLICY.horizonDays) break;
    }
  }
  return candidates;
}

function markdown(report) {
  const lines = [`# Race crawl ${report.generatedAt.slice(0, 10)}`, ""];
  for (const s of report.sources) {
    lines.push(
      `- **${s.id}**: ${s.discovered} discovered, ${s.fetched} pages fetched, ${s.candidates} parsed` +
        (s.pageErrors ? `, ${s.pageErrors} pages failed (last: ${s.lastPageError})` : "") +
        (s.error ? `, FAILED: ${s.error}` : ""),
    );
  }
  lines.push("", `Dropped: ${Object.entries(report.dropped).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
  lines.push(`Already in the catalogue: ${report.known}`, "");
  if (report.alreadyReported) lines.push(`Proposed in an earlier run, not repeated: ${report.alreadyReported}`, "");
  const { planned, written } = report;
  lines.push(
    written
      ? `Written: ${written.races} races, ${written.editions} editions (unverified), ${written.ledger} ledger rows.`
      : `Dry run: would add ${planned.races} races and ${planned.editions} editions (unverified); ` +
        `${planned.review} wait for review, ${planned.waiting} for a second source.`,
    "",
  );
  const sections = [
    ["New editions of catalogue races", (p) => p.verdict === "newEdition"],
    ["Date changes", (p) => p.verdict === "dateChange"],
    ["New races, from a registration platform", (p) => p.verdict === "newRace" && p.candidate.firstHand],
    ["New races, aggregator only (check the organiser)", (p) => p.verdict === "newRace" && !p.candidate.firstHand],
    ["Needs a look (uncertain match)", (p) => p.verdict === "review"],
  ];
  for (const [title, pick] of sections) {
    const rows = report.proposals.filter(pick);
    lines.push(`## ${title} (${rows.length})`, "");
    if (!rows.length) continue;
    lines.push("| Date | Race | Where | km | Catalogue | Notes |", "|---|---|---|---|---|---|");
    for (const p of rows.slice(0, 200)) {
      const c = p.candidate;
      const notes = [
        p.status === "inserted" ? "**added**" : `waits: ${p.note}`,
        p.previousDate && `was ${p.previousDate}`,
        p.why,
        ...p.flags,
        p.alsoIn && "two sources",
      ];
      lines.push(
        `| ${c.date} | [${c.name.replace(/[|[\]]/g, " ")}](${encodeURI(c.url)}) | ${[c.city, c.country].filter(Boolean).join(", ")} ` +
          `| ${p.distances.join(", ")} | ${p.slug ?? ""} | ${notes.filter(Boolean).join("; ")} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const catalogue = await loadCatalogue();
  // What an earlier run already proposed is not repeated: the ledger table when writing, else a state file.
  const db = { projectRef: process.env.SUPABASE_PROJECT_REF, accessToken: process.env.SUPABASE_ACCESS_TOKEN };
  if (args.apply && !(db.projectRef && db.accessToken)) {
    throw new Error("--apply needs SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN.");
  }
  const state = !args.apply && args.state && existsSync(args.state) ? JSON.parse(readFileSync(args.state, "utf8")) : { seen: {} };
  const seenKeys = args.apply
    ? new Set((await runSql(LEDGER_KEYS_SQL, db)).map((r) => r.key))
    : new Set(Object.keys(state.seen));
  const countries = args.countries.split(",").map((c) => c.trim().toUpperCase());
  const wanted = args.sources.split(",").map((s) => s.trim());
  const crawlers = {
    rockthesport: (stats) => crawlRockTheSport(stats),
    runninglife: (stats) => crawlRunningLife(stats, countries, catalogue, seenKeys),
  };
  const sources = [];
  // One source failing must not lose the others' week.
  const results = await Promise.all(
    wanted.map(async (id) => {
      const stats = { id, discovered: 0, fetched: 0, unparsed: 0, candidates: 0 };
      sources.push(stats);
      try {
        const found = await crawlers[id](stats);
        stats.candidates = found.length;
        return found;
      } catch (err) {
        stats.error = err.message;
        return [];
      }
    }),
  );

  const dropped = {};
  let known = 0;
  const proposals = [];
  for (const candidate of results.flat()) {
    const verdict = classify(candidate, catalogue, today);
    if (verdict.verdict === "dropped") dropped[verdict.why] = (dropped[verdict.why] ?? 0) + 1;
    else if (verdict.verdict === "known") known++;
    else proposals.push({ ...verdict, candidate });
  }
  const all = mergeSources(proposals).sort((a, b) => a.candidate.date.localeCompare(b.candidate.date));
  const worth = all.filter(worthProposing);
  dropped["new race under marathon, one aggregator only"] = all.length - worth.length;

  const keyOf = (p) => ledgerKey(p.candidate);
  if (!args.apply && args.state) {
    const keepFrom = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
    const seen = Object.fromEntries(Object.entries(state.seen).filter(([, day]) => day >= keepFrom));
    for (const p of worth) seen[keyOf(p)] ??= today;
    mkdirSync(dirname(resolve(args.state)), { recursive: true });
    writeFileSync(args.state, JSON.stringify({ seen }));
  }
  // One key once: the same page can sit in two sitemaps, and a listing can shift mid-crawl, and two
  // ledger rows with one key in one INSERT … ON CONFLICT abort the whole statement.
  const unique = new Map();
  for (const p of worth) if (!seenKeys.has(keyOf(p)) && !unique.has(keyOf(p))) unique.set(keyOf(p), p);
  const merged = [...unique.values()];

  const taken = new Set([...catalogue.races.map((r) => r.slug), ...catalogue.editions.map((e) => e.id)]);
  const writes = { races: [], editions: [], ledger: [] };
  for (const p of merged) {
    const w = plan(p, catalogue, taken);
    p.status = w.ledger.status;
    p.note = w.ledger.note;
    writes.ledger.push(w.ledger);
    if (w.race) writes.races.push(w.race);
    if (w.edition) writes.editions.push(w.edition);
  }
  let written = null;
  if (writes.ledger.length && (args.apply || args["sql-out"])) {
    const sql = buildSql(writes);
    if (args["sql-out"]) writeFileSync(args["sql-out"], sql);
    if (args.apply) written = (await runSql(sql, db))[0];
  }
  const alreadyReported = worth.length - merged.length;
  const report = {
    generatedAt: new Date().toISOString(),
    sinceDays,
    sources,
    dropped,
    known,
    alreadyReported,
    planned: {
      races: writes.races.length,
      editions: writes.editions.length,
      review: writes.ledger.filter((l) => l.status === "review").length,
      waiting: writes.ledger.filter((l) => l.status === "waiting").length,
    },
    written,
    proposals: merged,
  };

  const md = markdown(report);
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(`${args.out}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${args.out}.md`, md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.slice(0, 900_000));
  console.log(md.split("\n").slice(0, 12).join("\n"));
  console.log(`\n${merged.length} proposals → ${args.out}.md / .json`);
  // Red when anything was lost, after the rest of the week has been written.
  if (sources.some((s) => s.error || s.pageErrors)) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
