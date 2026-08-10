# Social features: the assessment, and why they're deferred

Banked during the 2026-08 retention cycle, when social came up as a candidate
and lost to `docs/reminders.md`. Nothing here is built. Read this before
starting on sharing, leaderboards, friends, or clubs so the same ground isn't
re-surveyed.

The two ideas on the table were **post-run sharing** and **leaderboards**. They
look like one theme and are not: one is an acquisition play that fits the
existing architecture, the other needs a different privacy model than the app
has.

## Post-run share card — the strong one, when its turn comes

A shareable image or link for a finished run: route, distance, pace, and any
personal best it set.

**Why it's plausible.** Nearly all the substrate exists:

- `bestEfforts` is already extracted at save time and ranked in memory
  (`docs/best-efforts.md`), and `RunAchievementSheet` already stages the "you
  just PB'd" moment. The emotional payload is built; only the export is missing.
- The public `/watch/:token` live-run page (`docs/live-sharing.md`) already
  proves out anonymous, token-addressed, server-mediated read access to one
  run — the same shape a finished-run share needs.
- Route rendering, splits and the elevation/pace chart all exist client-side.

**What it actually is: acquisition, not retention.** It puts the app in front of
people who don't have it. That makes it a *different bet* from the retention
loop, to be judged on installs rather than on week-one activity — and it only
pays once there is something to retain the people it brings in. That sequencing
is why it lost this round, not any doubt about the idea.

**Open questions before building.** Map tile licensing and attribution if a
route is baked into an exported image (Leaflet + the tile provider's terms, not
just ours to decide); whether the artefact is an image or a link (a link reuses
the token infrastructure and stays revocable, an image travels further but can
never be unshared); and whether a run's share defaults to public — it must not.

## Leaderboards — premature, and against the grain

**Verified against production on 2026-08-07, not assumed:**

- **There is no public identity to show.** `public.profiles` has exactly six
  columns: `id`, `created_at`, `last_seen_at`, `coach_daily_limit`,
  `premium_until`, `premium_since`. No display name, no handle, no avatar. The
  account email lives only in `auth.users` and was deliberately dropped from
  `profiles` (migration `20260804130743`). A leaderboard would first have to
  invent a public identity and ask every existing user to choose one.
- **Nothing is cross-user readable.** Every per-user table — `app_state`,
  `run_routes`, `saved_routes`, `live_runs`, `profiles`, `agent_trajectories`,
  `agent_rounds` — has exactly one SELECT policy, `auth.uid() = user_id`. The
  only `SELECT USING (true)` policies are `app_config`, `races` and
  `race_editions`: the shared race *catalogue*, which holds no personal training
  data. Even the public live-run page can't read `live_runs` directly; it goes
  through the `live-watch` edge function under service role.

  So a leaderboard is not a feature that reads existing data differently. It
  requires **new** cross-user exposure of training data, and that is the one
  thing the schema has been consistently built to prevent.
- **It would look abandoned.** 26 accounts, 9 of whom have ever logged a run, 4
  with three or more. A leaderboard needs density before it means anything, and
  an empty one actively signals a dead app.
- **It contradicts a decision already taken.** `src/utils/badges.ts` avoids
  streaks on purpose ("never a fragile 'don't break the chain' streak") and
  scores consistency forgivingly. Ranking runners against each other is the same
  pressure mechanic wearing a different hat. If that stance ever changes it
  should change deliberately and in writing, not as a side effect of shipping a
  leaderboard.

**If it is ever revisited**, the honest minimum is: an opt-in public identity, a
segment small enough to be meaningful (a club or a race field, not "all users"),
per-user opt-in to appear at all, and an RLS story that doesn't widen the
default. That is a substantial privacy design, not a feature ticket.

## The order these would go in

1. **Post-run share card**, once retention is worth feeding — it compounds with
   the race catalogue and needs no new privacy model.
2. **Race-field comparison** (how you placed among app users in a race you both
   ran) — a bounded, naturally-consented version of the leaderboard idea that
   rides the existing shared race catalogue rather than exposing training logs.
3. **General leaderboards / friends / clubs** — only with the identity and
   consent design above, and only at a user count where they read as alive.

Related: `docs/live-sharing.md` (the existing token-based sharing seam),
`docs/best-efforts.md` (the PB moment a share card would carry),
`docs/monetization.md` (where a share card sits relative to the premium lineup),
`docs/races.md` (the shared catalogue).
