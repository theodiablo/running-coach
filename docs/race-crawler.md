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
  A failed run emails the maintainer through SES (the `SES_REPORT_AWS_*` user
  `ses-weekly-report.yml` already uses, to the `MAINTAINER_EMAIL` repo secret),
  with the run link and the report's head.
- **By hand:** `SUPABASE_URL=https://<ref>.supabase.co node scripts/race-crawler/crawl.mjs`
  reports only (`--sources`, `--countries ES,FR,GB,IE`, `--since-days 15`,
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
matched race, at the race's own distance, or a new race, when a registration
platform lists it or two sources agree. An aggregator alone is never enough: it
lists next year's edition before the organiser announces a date (Toulouse 2027
in the first review), and gives a multi-day event's first day, which need not
be race day (Snowdonia, Mont-Saint-Michel), so multi-day events always wait. One race per
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

Before adding a source, run the **Race source probe** workflow
(`race-source-probe.yml`, `scripts/race-crawler/probe.mjs`): it requests one
page per candidate from GitHub's runners, which some sites refuse even though
they answer a desk. Also read the site's terms, not only its robots.txt.

running.life is **local only** (`--sources runninglife`): Cloudflare answers
GitHub's runners with a challenge (403), its race sitemaps included, so the
scheduled run leaves it out. A feed or an allowance agreed with running.life is
the way back into the schedule, not a way round the challenge.


| Source | Countries | Kind | Discovery | Extraction |
|---|---|---|---|---|
| Rock the Sport | ES (also PT, AD, MX, PA) | registration platform: first-hand | per-country event sitemaps, by `lastmod` | `SportsEvent` JSON-LD + the page's Next.js payload (`subsports`, fare names and descriptions, city, country) |
| Find a Race | GB (some IE, FR, ES) | listings, some entries: second-hand | `events-current` (each event's next edition) and `events-future` sitemaps, by `lastmod` | `SportsEvent` JSON-LD (offer names for distances, address for town and country); the breadcrumb's sport keeps out triathlons and the like |
| ATS Sport | FR (mostly the south) | registration and timing platform: first-hand | the sitemap's `epreuve.php` URLs, by `lastmod` | `SportsEvent` JSON-LD (name, date, town, département) + the course list: each course's type keeps the runs ("Trail", "Course sur route", "Semi Marathon"…), its name gives the distance. No coordinates on the page: the town's centre comes from geo.api.gouv.fr (official name, same département), best effort. An old page's structured date moves a year on by itself (same weekday) while its text keeps the real one: a page whose description names years, none of them the event's, goes to review ("date not confirmed by the page") |
| running.life (local only) | ES, FR, GB, IE | aggregator: second-hand | per-country calendar, 20 events a page | the listing's `ItemList` JSON-LD; the event page only for survivors (full description, organiser link) |

A source is an adapter in `scripts/race-crawler/sources/` returning the same
candidate shape (`rockthesport.mjs` is the reference). Parsers are pure and
tested on fixtures shaped like the real pages (`src/raceCrawler.test.ts`), so a
site redesign fails a test, not the catalogue. Checked and left out:
RunIreland (its events calendar has held almost nothing since 2020), njuko
(registration pages only, no public list of events), Finishers (its terms forbid
automated collection, and building a calendar from its data, without written
agreement), the FFA calendar (robots.txt disallows it), and Protiming, Klikego
and Popup Races (they refuse GitHub's runners).

## Curated policy (`classify.mjs`, `POLICY`)

- **Running only, 10 km and up.** Distances below 10 km are dropped; an event
  with only short distances is dropped. Multisport, walks, virtual, cancelled
  and past events are dropped.
- **New races, 10 km and up too.** The catalogue pages and filters its races,
  so a race it lacks needs no more than an edition does (`minNewRaceKm`); an
  aggregator-only one still waits for a second source (`minNewRaceKmSecondHand`
  is the bar for logging it). Raise either to ask more of new races.
- **Aggregator dates are never trusted alone**: every Find a Race or
  running.life proposal is flagged "second-hand date", to be confirmed on the organiser's site, as the
  curation rules in `docs/races.md` require. Weekday dates are flagged.

- **Terrain:** a new race is `trail` when its source says so (Rock the Sport's
  `sport`) or its name has a trail word (`isTrail`), else `road`
  (`docs/races.md`).

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

France has only ATS Sport, which is regional, and Ireland only what Find a
Race lists. Candidates: Le-Sportif (French registration platform; answers
GitHub, but its pages carry no structured data) and Eventmaster (Irish
registration). The FFA's calendar would be the complete French source, but
only with the federation's agreement.
