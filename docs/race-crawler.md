# Race crawler

A scheduled script that finds new races and editions for the shared catalogue
(`docs/races.md`) without an LLM: fixed parsers over structured data the sources
already publish. **Phase 1 is dry-run**: it reads the sources and the live
catalogue and writes a report; it never writes to the database. Adding rows stays
the maintainer's call, through the same SQL as `validate-contribution`.

## Running it

- **Scheduled:** `.github/workflows/race-crawler.yml`, Mon + Thu. The report is
  the job summary and the `race-crawl-report` artifact (`.md` + `.json`).
- **By hand:** `SUPABASE_URL=https://<ref>.supabase.co node scripts/race-crawler/crawl.mjs`
  (`--sources`, `--countries ES,FR,GB,IE`, `--since-days 8`, `--max-pages N`,
  `--state file`, `--out prefix`). The catalogue is read with the public anon
  key from `src/config.ts`: the same read every app client does.
- **Not repeated:** `--state` remembers what was proposed (180 days), so each
  report lists only what is new since the last run. In CI the state rides the
  Actions cache; twice a week keeps it inside the cache's 7-day eviction.
- **Polite by construction:** one request per second per host, a named
  user-agent, only paths `robots.txt` allows (Rock the Sport disallows `/api/`,
  so pages only). A source that fails is reported; it never loses the others' run.

## Sources

| Source | Countries | Kind | Discovery | Extraction |
|---|---|---|---|---|
| Rock the Sport | ES (also PT, AD, MX, PA) | registration platform: first-hand | per-country event sitemaps, by `lastmod` | `SportsEvent` JSON-LD + the page's Next.js payload (`subsports`, fare names, city, country) |
| running.life | ES, FR, GB, IE | aggregator: second-hand | per-country calendar, 20 events a page | the listing's `ItemList` JSON-LD; the event page only for survivors (full description, organiser link) |

A source is an adapter in `scripts/race-crawler/sources/` returning the same
candidate shape (`rockthesport.mjs` is the reference). Parsers are pure and
tested on fixtures shaped like the real pages (`src/raceCrawler.test.ts`), so a
site redesign fails a test, not the catalogue. Sources checked and left out
(Cloudflare, robots, terms): see the PR that added this.

## Curated policy (`classify.mjs`, `POLICY`)

- **Running only, 10 km and up.** Distances below 10 km are dropped; an event
  with only short distances is dropped. Multisport, walks, virtual, cancelled
  and past events are dropped.
- **New races are a higher bar than new editions.** A race the catalogue lacks
  needs a half marathon or longer, and a marathon or longer when only an
  aggregator lists it (a half seen in two sources still counts).
- **Aggregator dates are never trusted alone**: every running.life proposal is
  flagged "second-hand date", to be confirmed on the organiser's site, as the
  curation rules in `docs/races.md` require. Weekday dates are flagged.

## Matching (`matchRace`)

Same country, within 30 km (or the same city when a side has no pin), at least
one shared distance, and then the name. Names are compared on their
*distinctive* tokens: edition numbers, years, filler, the kind of race ("media
maratón", "san silvestre", "cross") and the town are removed, so two San
Silvestres in Madrid are different races and "XXVI Media Maratón San Sebastián
2027" is the catalogue's San Sebastián half. A name that is only "<kind>
<town>" matches the same kind in the same town, sponsor prefix or not. The
organiser's own site is the strongest signal, but only with the name agreeing
too (a marathon's breakfast run shares its site). Anything in between is
"needs a look", never a guess.

A matched candidate is `known` (the edition exists), `dateChange` (an upcoming
edition within 75 days of it), or `newEdition`.

## Next phases

1. Staging table + auto-insert of clean first-hand proposals as
   `verified = false` rows (service role, from the workflow).
2. A review skill over the staged rows, like `validate-contribution`.
3. More sources, one adapter each: Find a Race (UK) and RunIreland (Ireland,
   WordPress events API) as second sources.
