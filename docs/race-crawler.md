# Race crawler

A scheduled script that finds new races and editions for the shared catalogue
(`docs/races.md`) without an LLM: fixed parsers over structured data the sources
already publish. It adds the clean proposals to the catalogue as **unverified**
rows and logs every proposal in a ledger; a person (the `review-race-crawl`
skill) verifies, fixes or rejects them.

## Running it

- **Scheduled:** `.github/workflows/race-crawler.yml`, Mondays. It writes
  through the Supabase Management API with the `SUPABASE_ACCESS_TOKEN` secret
  the release workflows already use; without it, or with `dry_run`, it only
  reports. The report is the job summary and the `race-crawl-report` artifact.
- **By hand:** `SUPABASE_URL=https://<ref>.supabase.co node scripts/race-crawler/crawl.mjs`
  reports only (`--sources`, `--countries ES,FR,GB,IE`, `--since-days 8`,
  `--max-pages N`, `--state file`, `--out prefix`). `--sql-out file` writes the
  statement it would run, for review; `--apply` (with `SUPABASE_PROJECT_REF` +
  `SUPABASE_ACCESS_TOKEN`) runs it. The catalogue is read with the public anon
  key from `src/config.ts`.
- **Polite by construction:** one request per second per host, a named
  user-agent, only paths `robots.txt` allows (Rock the Sport disallows `/api/`,
  so pages only). A source that fails is reported; it never loses the others' run.

## The ledger (`race_crawl_items`)

One row per proposed event, keyed by source, source key and date, service-role
only. A key already in the ledger is never proposed again, whatever its status,
so a rejection sticks. `status`:

- `inserted`: the crawler added the race and/or edition (`verified = false`).
- `review`: it added nothing and a person should look; `note` says why (a date
  change, an uncertain match, a weekday or TBC date, no coordinates…).
- `waiting`: a new race only an aggregator lists. Logged so it is not proposed
  again, kept out of the review queue, and added by itself once a second
  source lists the same event.
- `verified` / `rejected`: a person dealt with it.

**What goes in without a person** (`apply.mjs`, `plan`): a new edition of a
matched race, at the race's own distance; a new race from a registration
platform, or from an aggregator once a second source lists it. One race per
event, at its headline distance (the half of a "media maratón" with a 10K, else
the longest), named without edition number or year. Never a date change, which
could move a date a runner trains for (`docs/races.md`, "Catalogue date
changes"). Everything is written in one idempotent statement: an existing slug
or edition is never overwritten.

## The first load

The 2026-11-15 full crawl was loaded by hand from a local run (`--sql-out`,
reviewed row by row) before the ledger table existed: 83 races and 18 new
editions of catalogue races, all unverified. The first scheduled run after the
migration logs what that run left for review and the aggregator-only races.

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

## Next

More sources, one adapter each: Find a Race (UK) and RunIreland (Ireland,
WordPress events API) as second sources, which also lets aggregator-only races
in through the two-source rule.
