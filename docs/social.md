# Social features: what we're building, and what we're not

The 2026-08 retention cycle banked social as "later". In 2026-11 the
maintainer picked three features to prepare for organic growth while the user
base is still small, choosing from design proposals (canvases linked below).
This file holds the decisions and their reasons; each feature's technical
design lives in its own doc once written. Read this before starting on
sharing, cheering, race fields, leaderboards, friends or clubs.

## Decided (2026-11)

One feature per session and per design doc, each shipped as small PRs:
design doc first (draft PR, approved before any code), then implementation.

### 1. Post-run share card (`docs/share-card.md`)

Canvas: https://claude.ai/artifact/TJeaNbU8BedgAJN5o6hTG4

- **Three styles, the runner picks**: A "Route line" (route drawn as our own
  vector line, no map tiles, so no tile licence or attribution in an exported
  image), B "Big number" (one headline figure, e.g. a new best), D "Training
  week" (race, days to go, week n of m, this week's sessions). The share
  builder shows all three and **pre-selects by context**: a personal best →
  B, a run that settled a plan session → D, otherwise A.
- **Analytics**: which style was pre-selected, which was chosen, whether the
  runner changed it, reported in the weekly maintainer digest
  (`docs/product-metrics.md`). Where the counts come from (product analytics,
  which only sees consenting users, vs a server-side counter) is a design-doc
  decision; consent rules in `docs/telemetry.md` still apply.
- Start and finish are trimmed by default so a card never points at a door.
- Image first. A revocable share link (token-addressed like `/watch/`) is a
  possible later step, not in scope.
- Rejected: C "Photo sticker" (transparent overlay), not chosen.

### 2. Live watch page CTA (`docs/live-sharing.md`)

Canvas: https://claude.ai/artifact/N5kqtYR7vPTsPgDcK8oH61

The page already sells the app (pinned row, About sheet, ended card); these
make the pitch fit the moment.

- **D: finish recap** — a stronger ended state: the run's recap, then "Start
  my plan, free" on the web (free account) before the store buttons. Web
  page only; ship first.
- **B: race context** — when the runner is racing, the page names the race,
  shows progress along its distance, and offers a plan for that race's next
  edition. Needs the live row to carry the race (edition id), which only
  exists in race-day mode.
- **Deferred: A "Send a cheer"** — anonymous one-tap cheers the runner hears.
  Kept as a follow-up once the rest ships: unlikely to move conversion much,
  and the screen-off Android path (no JS runs) makes it the heaviest piece.
- Rejected for now: C "Do you run too?" (a question splitting runners from
  supporters).

### 3. Race field view (`docs/race-field.md`)

Canvas: https://claude.ai/artifact/6c47MzKHHGboxxcoWJLUsp

- **Opt-in public name**: a new `profiles` column set on its own Settings ›
  Account page, off until set, never in the `app_state` blob, never shown
  next to runs, routes, plan or email.
- **Joining a field is per race**, asked once: show me by name, just count
  me, or not this time. Participations live in the blob today, so the field
  needs its own table, written only by its owner and read only through a
  function that applies each runner's choice and shows nothing until at
  least 3 have joined. First cross-user exposure in the app: security review
  before merge.
- **A: the count** ("9 app runners in this field") and **B: who's running**
  (opted-in names, optional goal time, "n others aim for about your time").
- **Rejected: C, results ranked among app runners.** Ranking runners against
  each other demotivates beginners; same stance as `badges.ts` (no streaks,
  forgiving consistency). Don't add finish positions or a leaderboard
  without revisiting this deliberately.
- **Rejected for now: D, a live map of the field on race day.**

## Leaderboards: still premature, and against the grain

Verified against production on 2026-08-07:

- **No public identity existed.** `public.profiles` had no display name,
  handle or avatar; the account email lives only in `auth.users`. The race
  field's opt-in public name is the first one, and it is scoped to race
  fields only.
- **Nothing is cross-user readable** except the race catalogue (`races`,
  `race_editions`) and `app_config`. Every per-user table has one SELECT
  policy, `auth.uid() = user_id`; the public live page reads through the
  `live-watch` edge function. A leaderboard needs new cross-user exposure of
  training data, which the schema was built to prevent.
- **It would look abandoned** at today's user count, and an empty one
  signals a dead app.
- **It contradicts `badges.ts`**: ranking runners is the streak pressure
  mechanic in another form. Change that stance in writing, not as a side
  effect.

If revisited, the honest minimum is: an opt-in identity, a small meaningful
segment (a club, a race field), per-user opt-in to appear, and an RLS story
that doesn't widen the default.

Related: `docs/live-sharing.md` (token-based public sharing),
`docs/best-efforts.md` (the PB moment), `docs/run-celebration.md` (the finish
screen), `docs/races.md` (the catalogue), `docs/telemetry.md` (consent),
`docs/product-metrics.md` (the weekly digest).
