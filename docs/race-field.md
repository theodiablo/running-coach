# Race field: technical design

Status: **approved 2026-11; PR 1 (public name, membership, join sheet, count)
and PR 2 (who's running, reporting a name) implemented.** Next: the one-time
Home intro card (Decisions 5) and the past-race purge.
Product decisions: `docs/social.md` §3. Canvas:
https://claude.ai/artifact/6c47MzKHHGboxxcoWJLUsp (`Main`, `Field-Join`,
`Field-Count`, `Field-List`; `Field-Results` and `Field-Live` are rejected).

This is the first time anything about one runner is shown to another. Every
choice below is the narrowest one that delivers the canvas: nothing becomes
readable cross-user except through one function, that function returns only
what each runner chose to show, and it returns nothing at all for a small field.

## What crosses the user boundary, and what never does

| Shown to other runners | Only if | Never shown |
|---|---|---|
| That *someone* joined (the count) | they picked "show me by name" or "just count me" for that edition, and ≥ 3 others joined | user id, email, any run/route/plan data (but the count's movement is observable: see "what it can't stop") |
| Their public name | they set one **and** picked "show me by name" for that edition | the private `settings.name` from the blob |
| Their goal time for that race | they turned on "Show my goal time" for that edition | finish times, results, positions (rejected: `Field-Results`) |

`Field-Join`'s "Show my finish time after the race" toggle is **dropped**: it
contradicts the no-results decision. Nothing in this design stores a result.

## Schema (PR 1, one migration via `supabase migration new race_field`)

### `profiles.public_name`

```sql
alter table public.profiles add column public_name text
  constraint profiles_public_name_shape check (
    public_name is null or (
      char_length(public_name) between 2 and 24
      and public_name !~ '^[[:space:]]|[[:space:]]$'
      and public_name !~ '[[:space:]]{2,}'
      and public_name !~ '[[:cntrl:]]'
      and public_name !~ '[\u00AD\u034F\u061C\u115F\u1160\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\u3164\uFE00-\uFE0F\uFEFF\uFFA0\U000E0000-\U000E007F]'
      and public_name !~* '(https?:|www\.|://|@|\.(com|net|org|io|fr|es)\y)'
      and public_name ~ '[[:alpha:]]'
    ));

grant update (public_name) on public.profiles to authenticated;
```

Postgres regex notes: `\y` is the word boundary (`\b` is a backspace there);
`btrim()` trims only U+0020, hence the `[[:space:]]` anchors (NBSP, U+3000);
invisible characters are written as `\u`/`\U` escapes (valid under
`standard_conforming_strings`), never as raw characters an editor can strip.
U+3164 and friends are "letters" that render blank, so they're excluded
explicitly. `[[:alpha:]]` follows the database ctype: verified on the preview
branch with an all-non-ASCII name (`Ωμέγα`), not just `Zoé L.`.

- The client writes it with `.update()`, never an upsert: there is no insert
  grant on `public_name`, and an upsert's `on conflict` would need one.
- **Write path: a column grant, not an RPC.** `authenticated` already holds
  `update (last_seen_at)` and the `profiles update own` policy (`using (id =
  (select auth.uid()))`; no explicit `with check`, so Postgres reuses `using`,
  and `id` has no update grant anyway). Adding `public_name` to the
  column grant lets a user write exactly that column of exactly their own row;
  `premium_until`/`premium_since` stay ungranted, so entitlement is still
  service-role-writable only. An RPC would add a `security definer` surface for
  nothing. The constraint is the bound, so it holds whoever writes (the client,
  a maintainer, a future function).
- **Shape rules** (the constraint above, mirrored client-side for copy, the
  server is the authority): 2–24 characters (the canvas' `maxlength`), trimmed,
  no runs of spaces, no control, zero-width or bidi-override characters (they
  make one name render as another, or flip the row around it), no URL or email
  shapes (the list must not become an ad slot), at least one letter. Unicode
  letters are allowed (`Zoé`, `Iñaki`, `Łukasz`): `[[:alpha:]]` under the
  database's UTF-8 collation. "Remove my public name" writes `null`.
- **Not unique.** Two "Alex M." are fine; uniqueness would turn the column
  into an existence oracle ("is this name taken?") over every account.
- Not in `app_state`, not in the backup export, not read by the coach.

### `public.race_field_members`

```sql
create table public.race_field_members (
  user_id     uuid not null references auth.users(id) on delete cascade,
  edition_id  text not null references public.race_editions(id) on delete cascade,
  visibility  text not null check (visibility in ('named', 'count')),
  goal_sec    integer check (goal_sec is null or goal_sec between 600 and 86400),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, edition_id),
  check (goal_sec is null or visibility = 'named')
);
create index race_field_members_edition_idx on public.race_field_members (edition_id);

alter table public.race_field_members enable row level security;
-- Explicit in both directions: hosted gives a new table no grants, the local
-- stack GRANT ALL (same as live_share_tokens), so state the posture.
revoke all on public.race_field_members from anon, authenticated;
grant select, delete on public.race_field_members to authenticated;
grant insert (user_id, edition_id, visibility, goal_sec) on public.race_field_members to authenticated;
grant update (visibility, goal_sec) on public.race_field_members to authenticated;

create policy "race_field_members own" on public.race_field_members
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
```

- **One row = one runner who chose to appear.** "Not this time" writes *no
  row* (and removes one if present): we keep nothing about a runner who said
  no. The question is asked once, as the race is added from its race page;
  after that the race page's field card is the way in, so nothing about the
  answer needs storing in the blob.
- `goal_sec` is stored only when "Show my goal time" is on (null otherwise),
  not copied as a hidden value the function then filters. What isn't stored
  can't leak through a later bug.
- The owner's own row is readable (to render "You appear as …"); nobody
  else's is, by RLS. No policy grants a cross-user read: **the read function
  below is the only cross-user path**.
- `created_at`/`updated_at` are server-set: no client grant, `updated_at`
  stamped by a `before update` trigger. `user_id`/`edition_id` are insert-only,
  so a row can't be moved to another race or another runner.
- **Verified editions only.** An unverified edition's creator can still edit
  its date, distance and `race_slug` (and delete it), which would move or close
  other runners' field. The `before insert` trigger refuses a membership on an
  unverified edition and `race_field` treats one as closed. Verification is
  already the maintainer's job (`validate-contribution`), so a contributed race
  gets its field once verified (maintainer decision, 2026-11).
- **Cap:** the same trigger refuses a 31st *upcoming* membership per user (same
  shape as `live_share_tokens_cap`), so a script can't sprinkle one account
  across the catalogue. The count-then-insert isn't serialized per user, so
  concurrent inserts can overshoot by as many as land at once (as for
  `live_share_tokens`); the cap bounds a script, not a race of requests.
- Trigger functions are `security invoker`, `set search_path = ''`, `revoke
  execute ... from public`. **Invoker is load-bearing for the cap** (said in
  its function comment): BEFORE triggers run before the RLS `with check`, so as
  invoker its count sees only the caller's own rows and a forged `user_id`
  counts 0 before RLS rejects the insert; as definer its error would reveal
  "this account has 30 fields".
- **No service-role grant**: no edge function touches the table in either PR.
  `src/serviceRoleGrants.test.ts` only flags tables a function uses, so it stays
  green; the first function that reads it must add `grant ... to service_role`
  in its own migration.
- `on delete cascade` on `edition_id`: a contributor deleting their own
  unverified edition would remove its field, but fields only exist on verified
  editions, which clients can't edit or delete.

## The read function: `public.race_field(p_edition_id text) returns jsonb`

The one cross-user read. It must see other users' rows and `profiles.public_name`,
which RLS hides from the caller, so it is **`security definer`** — the second
client-callable definer after `delete_my_account`, added to
`CLIENT_CALLABLE_DEFINERS` in `src/migrationConventions.test.ts` with the
reason in the migration and the function comment (lint 0029 finding accepted,
as for `delete_my_account`).

```sql
create or replace function public.race_field(p_edition_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_date   date;
  v_others integer;
  v_mine   public.race_field_members%rowtype;
begin
  if v_uid is null then
    raise exception 'race_field: no authenticated user' using errcode = '28000';
  end if;

  select e.date into v_date from public.race_editions e
    where e.id = p_edition_id and e.verified and length(p_edition_id) <= 200;
  select * into v_mine from public.race_field_members m
    where m.user_id = v_uid and m.edition_id = p_edition_id;
  select count(*) into v_others from public.race_field_members m
    where m.edition_id = p_edition_id and m.user_id <> v_uid;

  -- One shape for "no such edition", "past race", and "fewer than 3 others".
  if v_date is null or v_date < current_date - 1 or v_others < 3 then
    return jsonb_build_object('open', false, 'joined', v_mine.user_id is not null);
  end if;

  return jsonb_build_object(
    'open', true,
    'joined', v_mine.user_id is not null,
    'count', v_others + (v_mine.user_id is not null)::int
    -- PR 2 adds 'named' here; PR 1 returns the count only.
  );
end;
$$;

revoke all on function public.race_field(text) from public, anon;
grant execute on function public.race_field(text) to authenticated;
```

### The k ≥ 3 threshold, and what it does and doesn't protect

- **Threshold counts *others*, not the field including the caller.** If it
  counted the caller, one account could join a field and learn from "3" that
  exactly two others exist. Counting others means a lone prober sees nothing
  until three real other runners are there, and the join sheet's own copy
  ("8 other Running Coach runners have joined") is the number the function
  already computes.
- **One response shape below the threshold.** 0, 1 and 2 others, a past
  edition and a non-existent edition id all return exactly `{"open":false,
  "joined":<own row>}`; `joined` is the caller's own row, which they can already
  read through RLS. No count, no "almost there", no different error.
- **No filters to slice the field.** The function takes one argument, the
  edition id. No distance, goal band, country or date parameter exists, so a
  caller can't intersect two "≥ 3" answers into a "1". The "n others aim for
  about your time" line (PR 2) is computed **client-side from the rows already
  returned** (named runners who chose to show a goal), so it can never reveal
  more than the list does. Count-only members contribute to the total and
  nothing else.
- **Timing.** The below-threshold path runs the same three indexed lookups as
  the open path and only skips building the list; the difference is
  sub-millisecond against a network round trip, and it would reveal "open vs
  not", which the response already says. No early return before the count.
- **What it can't stop: watching the count move.** Anyone who can see an
  open field can poll it and date each join or leave; and with signups open,
  two throwaway accounts plus the caller's own lift a two-runner field over the
  threshold. No SQL closes this. What bounds it: a count-only member reveals
  *only that someone joined*, never who, and a named member chose to be seen.
- **The one identity-bearing difference (PR 2):** switching from "by name" to
  "just count me" (or removing the public name) takes the name off the list
  while the count holds, so a watcher learns that runner is still in. The copy
  says so where it happens instead of promising otherwise: "Your name leaves
  the list. To leave the field too, choose Not this time."
- **Past races close the field** (`date < current_date - 1`, one day of grace
  for time zones): there are no results to show, and a field that lingers
  after the race is a list of who ran it.

### PR 2: the named list

`race_field` gains `named` in the open branch, built from the *same* row set
and gated on the caller's own membership (a non-member gets `'named': []` and
the same count):

```sql
'named', case when v_mine.user_id is null then '[]'::jsonb else coalesce((
  select jsonb_agg(jsonb_build_object('name', p.public_name, 'goalSec', m.goal_sec, 'me', m.user_id = v_uid)
                   order by m.goal_sec nulls last, p.public_name)
  from public.race_field_members m
  join public.profiles p on p.id = m.user_id
  where m.edition_id = p_edition_id
    and m.visibility = 'named'
    and p.public_name is not null), '[]'::jsonb) end
```

- A `named` member with no public name (they removed it later) shows as
  count-only, never as a blank row or a placeholder that hints at an account.
- **No ids in the payload**: no user id, no stable per-runner handle. Rows are
  ordered by goal then name, never by join time (which would date each join).
  The `me` flag marks the caller's own row only.
- **The list is shown only to a runner who has joined the field** (either
  visibility); anyone signed in sees the count. Seeing who's running is
  reciprocal (maintainer decision, 2026-11).
- Same name in several fields shows that person runs several races: inherent
  to a public name, said plainly on the Public name page.

## Account deletion, backup and restore

- **`delete_my_account`** deletes `auth.users`; `race_field_members.user_id`
  and `profiles.id` both cascade, so the name and every membership go in the
  same transaction. No change to the function. A test asserts the FK is
  `on delete cascade`.
- **In-app backup / restore** (`onBackup`/`onRestore`, the blob export): the
  public name and memberships are **not** exported. They're server-side
  consent, not training data, and a restored file must not re-publish a name or
  re-join fields someone left after taking the backup. A restore replaces the
  list, so any race it drops is a removal like the next bullet.
- **Removing a race, on any path** (`removePart`, a restore, anything that
  rewrites `rc_races`): `RunningCoach` diffs the listed editions on every
  change, and a race that left the list *on this device* is recorded as owed a
  delete (`rc_field_leaves:<uid>` in localStorage, per device; a race back on
  the list is dropped from it). Only those are ever deleted, never "every
  membership with no participation": this device's copy of the list can be
  stale (another device added a race and joined it), and a stale list must
  never undo a membership. The delete re-reads the list right before it runs,
  so a race re-added meanwhile is kept. It runs as soon as the list changes,
  and is retried once `isStoreReconciled()` on every boot, on `online`, on a
  return to the foreground, and on a 30s to 5 min backoff while it keeps
  failing. The owed list survives a killed app, so the next launch retries.
  The row is gone at the first try that succeeds; a backoff step is the gap
  between tries, not a bound. Until then the row still counts (PR 1), and in
  PR 2 still shows the runner's name to joined runners. A removal made while
  the app was uninstalled, or on a device that never ran again, is not caught;
  the past-race purge below bounds it.
- **Past races are purged.** A field closes the day after its race, and a
  membership on a past edition is a record of who ran it. Follow-up to PR 1:
  the daily monitoring job deletes memberships on editions older than 7 days
  (`docs/monitoring.md` gains the line).
- **Daily DB backup** (`docs/backups.md`): `db_backup` has
  `pg_read_all_data`, so the new table and column are dumped with no grant
  change. A single-user restore from it touches `app_state` only; membership
  rows are never restored by hand (they would re-expose a choice the runner may
  have reversed). A whole-database or point-in-time restore brings back public
  names and memberships as of the snapshot, so a runner who withdrew after it
  would appear again. **Before the restored project serves any app traffic**,
  clear both (`update profiles set public_name = null; delete from
  race_field_members;`), then let runners re-join, rather than resurrect a
  withdrawn consent. This step belongs to the restore itself, not to a later
  cleanup.

## Name abuse and moderation (basics)

- **Shape** is enforced by the constraint above (no links, no invisible
  characters, length-capped).
- **Report** (PR 2): each named row has a "Report this name" action, writing a
  `race_reports` row with `reason = 'field_name'`, `edition_id`, and the
  reported name *text* in `note`. No user id leaves the server, so a report
  can't be used to learn one. `notify-contribution` emails the maintainer as
  for race reports (dedupe by report id). The name text has no user id to
  cascade on, so it would outlive the reported account: `field_name` reports
  are deleted once handled, and any older than 30 days by the daily
  monitoring job (`docs/monitoring.md` gains the line).
- **Maintainer action**: plain SQL, documented in this file once PR 2 lands.
  What's moderated is the *name text*, not a person: find the accounts with
  that exact `public_name` and a `named` membership on the reported edition,
  and `update profiles set public_name = null` for them (they drop to
  count-only everywhere). Two runners sharing an abusive text both carry it,
  so clearing both is right. A report that isn't about the text itself (e.g.
  "this is impersonating me") is never acted on by text match: the maintainer
  replies to the reporter first, since the name alone can't say which account
  is meant, and no per-row id is exposed to disambiguate it.
  A repeat offender gets the same via a `public_name_blocked boolean` column
  only if it's ever needed; not built now.
- No profanity list: lists are locale-bound, easy to dodge and catch real
  names. Volume is tiny; report + manual null is proportionate.

### Moderating a reported name (maintainer SQL)

The report email (`notify-contribution`, subject "race field name report")
carries the report id, edition and name text. In the SQL editor:

```sql
-- 1. Who carries that exact text on that edition, by name:
select p.id from public.profiles p
join public.race_field_members m on m.user_id = p.id
where p.public_name = '<name>' and m.edition_id = '<edition>' and m.visibility = 'named';
-- 2. Only if the text itself breaks the rules (a report proves nothing on its own:
--    anyone can report any name text), clear it and move those runners' by-name
--    memberships to count-only, as removing a name in the app does, so a new name
--    can't reappear there. One statement, rechecking the text, so a runner who
--    renamed themselves since step 1 keeps the new name:
with hit as (
  update public.profiles set public_name = null
  where id in (<ids from 1>) and public_name = '<name>'
  returning id
)
update public.race_field_members set visibility = 'count', goal_sec = null
where user_id in (select id from hit) and visibility = 'named';
-- 3. Handled either way: the report holds name text with no account to cascade on.
delete from public.race_reports where id = '<report id>';
-- Reports never handled are cleared after 30 days:
delete from public.race_reports where reason = 'field_name' and created_at < now() - interval '30 days';
```

## Client data flow

### Modules

- `src/raceField.ts` is the only module touching the table or the function:
  `fetchRaceField(editionId)`, `fetchMyMembership(uid, editionId)`,
  `setFieldChoice(uid, editionId, choice, goalSec, current)` (an insert for a
  new membership, a plain `.update()` for a change, a delete for "Not this
  time"; never an upsert, whose `on conflict update` names
  `user_id`/`edition_id`, which have no update grant, and whose insert trigger
  would refuse a capped runner only changing visibility), `syncFieldGoal`,
  the owed-delete list (`noteListedEditions`, `pendingLeaves`,
  `leavePendingFields`) and `createFieldReconciler` (the retry schedule, which
  stops for good on `stop()`, even with a run in flight). `syncFieldGoal`
  updates only a goal already shown (`goal_sec` not null), so a hidden goal
  is never published by a later goal edit. Every read destructures `error`; a failed read renders as
  closed, never as "you're not in it" (which would invite a second join).
- `src/publicName.ts`: `fetchPublicName` / `savePublicName` (an update, never
  an upsert) and the pure `publicNameIssue` mirroring the constraint for
  inline errors. `RunningCoach` reads it once per signed-in user and passes
  it down (`shared.publicName`, `SettingsModal`); `undefined` means not read,
  and the Public name page then shows a retry instead of an empty field it
  would overwrite.
- `RunningCoach` owns the diff and the retry (above). Recording a removal is
  not gated on reconciliation: the diff runs on every change to the listed
  editions once the store has loaded (offline boots included), and writes the
  removal to the owed list in the same commit as the edit that made it, before
  any network. Its baseline is the list at the first loaded render, kept in
  memory and replaced on every diff; it needs no persistence because each
  removal is persisted the moment the diff sees it. Only the delete waits for
  `isStoreLoaded() && isStoreReconciled()`. The owed list's in-memory copy is
  the session's truth (a failed storage write must not hide a removal);
  localStorage seeds it and carries it across a killed app.

### Surfaces

- **Settings › Account › Public name** (`src/modals/settings/PublicNamePage.tsx`,
  canvas `Main`): reached from a row on `AccountPage` showing the name or
  "Off", never listed on the hub. Field, live preview, where it can appear,
  Save and Remove. Remove first moves every by-name membership to count-only
  (`hideNameInFields`), so a name set later never reappears on a field the
  runner was told they now count in without a name. `openSettings("publicName")` deep-links to it; back from a
  deep link closes settings, back from Account's row returns to Account.
- **Join sheet** (`src/modals/FieldJoinSheet.tsx`, canvas `Field-Join`):
  opened by the race page's "Add to my list" (the one automatic ask) and by
  the card's Join / Change button. Three choices: by name (disabled, with
  "Set a public name" beside it, when there's none), just count me, not this
  time; "Show my goal time" only under by name, and only when the race has a
  goal; it starts off, like every sharing switch in the app. Switching from
  by name to count says that the runner still counts.
  Dismissing changes nothing.
- **Race page card** (`src/components/races/RaceFieldCard.tsx` in `RaceSheet`,
  canvas `Field-Count`): only for an upcoming, verified catalogue edition.
  Open: "9 app runners in this field", "You're one of them" when joined.
  Joined but closed: "You're in. We'll show the field once a few more app
  runners join." Listed, not joined, closed: a short invite with Join.
  Not listed and closed: nothing. Join / Change only for a listed race, and
  hidden when the membership read failed. For a runner who joined an open
  field, "See who's running" opens the list.
- **Who's running** (PR 2, `src/modals/FieldListSheet.tsx`, canvas
  `Field-List`): the named rows, "And n more who joined without a name.", the
  "n others aim for about your time" line (named + shown goal within ±5% of
  the caller's own goal, only when the caller has one), and "You appear as …".
- **Goal sync**: `setGoal` (RacesView) and `updateTargetGoal` (and its undo)
  update `goal_sec` on a by-name membership; a no-op otherwise.

### Fetching

The card calls `fetchRaceField` (and `fetchMyMembership` for a listed race)
on every open of an eligible edition: no polling, no prefetch in
`RacesView`. The answer lives only in the card's state: no cross-open cache,
so another runner's withdrawal shows on the next open, and nothing outlives
sign-out. The viewer's own change refetches. No `localStorage` (it's other
people's data).

## Copy (en / fr / es)

New keys under `races.field.*` and `settings.publicName.*`. Plain words, sentence
case, no em dashes. French `tu`; Spanish informal, region-neutral. Races are
`course` / `carrera`.

| Key | en | fr | es |
|---|---|---|---|
| `races.field.card.count` | {{count}} app runners in this field | {{count}} coureurs de l'app dans cette course | {{count}} corredores de la app en esta carrera |
| `races.field.card.youreIn` | You're one of them | Tu en fais partie | Eres uno de ellos |
| `races.field.card.waiting` | You're in. We'll show the field once a few more app runners join. | C'est noté. On affichera les participants quand quelques coureurs de l'app de plus seront inscrits. | Listo. Mostraremos a los participantes cuando se unan algunos corredores más de la app. |
| `races.field.join.title` | Running with others from the app | Courir avec d'autres coureurs de l'app | Correr con otros de la app |
| `races.field.join.named` | Show me as {{name}} | M'afficher comme {{name}} | Mostrarme como {{name}} |
| `races.field.join.count` | Just count me | Me compter, sans mon nom | Solo cuéntame |
| `races.field.join.none` | Not this time | Pas cette fois | Esta vez no |
| `races.field.join.goal` | Show my goal time | Afficher mon objectif de temps | Mostrar mi tiempo objetivo |
| `settings.publicName.title` | Public name | Nom public | Nombre público |
| `settings.publicName.whereNo` | Never next to your runs, routes, plan or email. | Jamais à côté de tes sorties, parcours, plan ou e-mail. | Nunca junto a tus entrenamientos, rutas, plan o correo. |

The table is a sample from the design; the locale files are the source. `i18n.test.ts` pins register
and dashes. The count uses i18next plurals (`_one`/`_other`), though it is
never below 3.

## Telemetry

None in PR 1. If added later: one product-analytics event for the join
choice (`named`/`count`/`none`), under analytics consent only, never the name.

## Test plan

- **Migration conventions** (`src/migrationConventions.test.ts`):
  `race_field` added to `CLIENT_CALLABLE_DEFINERS`; trigger function pinned
  and invoker; policy uses `(select auth.uid())`.
- **`src/raceFieldMigration.test.ts`** (new, text-level over the migrations, like
  the existing convention tests): no policy on `race_field_members` other than
  the owner one; the table's grants are `revoke all` then exactly the column
  lists above; no `profiles` grant names `premium_until`/`premium_since`; both
  FKs `on delete cascade`. (The exact `profiles` column privileges are checked
  on the preview branch via `information_schema.column_privileges`, since old
  migration text still names the dropped `email`.)
- **SQL behaviour** checked once before merge on a Supabase preview branch
  (never `apply_migration` on production): as user A with 0/1/2/3 others the
  response shape is identical below 3; a past edition and an unknown id match
  it; A can't select B's row; A can't update B's `public_name` or own
  `premium_until`; A can't move a row to another edition or user; a join on an
  unverified edition fails and the field reads closed; the constraint rejects
  `"  "`, `"a"`, 25 chars, a bidi override, an NBSP edge, a U+3164 run,
  `alex.com`, `www.x.com`, and accepts `Zoé L.` and `Ωμέγα`; the 31st
  upcoming join fails;
  `delete_my_account` leaves no rows; in PR 2 a non-member caller of an open
  field gets `named: []` with the same count, a member gets the list.
- **Unit**: `publicNameIssue` mirrors every constraint rule (shared fixture
  list with the SQL check above); the owed-delete list (only this device's
  removals, re-added races kept, failures kept for retry, per user); the
  goal sync leaving a hidden goal hidden; the "about your time"
  count (±5%, excludes self, excludes hidden goals).
- **Components**: `RaceFieldCard` + `FieldJoinSheet` (card states, by name
  disabled without a name, goal toggle only under by name, refusals toasted),
  `PublicNamePage` (save, remove, inline error, failed read shows retry),
  `SettingsModal` (back from Public name).
- **SQL behaviour, as run for PR 1**: the migration was applied to PGlite with
  stubbed `auth` and every check in the SQL bullet above passed (38 cases);
  the Supabase Preview branch then applies it for real on the PR.
- **Opus security review of the final migration** before merge (CLAUDE.md:
  RLS and cross-user exposure).

## PR split

1. **PR 1: public name + table + join + count.** Migration (column,
   constraint, column grant, table, RLS, cap trigger, `race_field` returning
   the count), `src/publicName.ts`, `src/raceField.ts`, Public name page,
   `FieldJoinSheet`, `RaceSheet` count card, restore/remove reconcile, i18n,
   tests. Ships the whole privacy surface, so the security review happens here.
2. **PR 2: who's running.** `race_field` replaced to add `named` (a new
   migration), `FieldListSheet`, "about your time", report-a-name path
   (`race_reports` reason + `notify-contribution` case), moderation SQL in this
   doc.

PR 1 adds the CLAUDE.md line (*the race field is the only cross-user read of
runner data; `race_field` is its one door*) and the `docs/races.md` pointer.

## Design review

The RLS/grant/function design above was reviewed by an `opus` sub-agent against
the live migrations before this doc was proposed. Its findings are folded in:
explicit two-way table grants (hosted vs local stack asymmetry), insert-only
`user_id`/`edition_id` with no upsert path, `\y` not `\b`, Unicode-aware trim
and invisible-character escapes, verified editions only, `goal_sec` tied to
`named` in the schema, the honest limits of the threshold (count movement,
the named→count switch), and purging reported names. It found no path around
the function through RLS, PostgREST embedding, `count=exact`, FK/PK errors or
the cap trigger. The final migration gets its own review in PR 1.

## Decisions (2026-11)

1. Count visible to anyone signed in; named list only to runners who joined
   (enforced in `race_field`, not just the UI).
2. Threshold counts *others*: k = 3 runners besides the caller.
3. Fields on verified editions only.
4. Per-runner cap: 30 upcoming fields, kept.
5. Introducing it to existing runners: a one-time Home card, after PR 2. The
   ask in PR 1 only fires when a race is added, so runners whose races were
   already listed would never meet it. The card sits last in the Home attention
   slot, for a runner with an upcoming verified race on their list, and opens
   the join sheet. This knowingly breaks the "seeded `false` at onboarding"
   rule for one-time hints, which exists so a hint never ambushes an existing
   runner: here existing runners are the audience. No new onboarding step: a new
   runner's field is almost always closed, and the card reaches them too.
