-- Running Coach — live run sharing (premium).
--
-- One row per user, upserted by the recording phone every ~30s while a run is
-- in progress, and deleted when the run is saved or discarded. Any other signed
-- in session of the SAME account (the web app at home, a second phone) reads it
-- to watch the run unfold. There are no share links and no anonymous access:
-- `auth.uid() = user_id` is the whole authorization story, which is exactly why
-- this ships as one table rather than a token-scoped read path.
--
-- Why a table and not an ephemeral Realtime broadcast: each upsert carries the
-- WHOLE simplified trace, so a watcher joining late gets the full route for
-- free, and a phone that loses signal for ten minutes self-heals on its next
-- successful write instead of leaving a permanent hole. A 1h run simplified at
-- epsilon=5m is comfortably under 50KB.
--
-- Why NOT app_state: that blob is re-upserted whole on every state change and
-- is debounced for a completely different workload. High-frequency location
-- data does not belong in it.

-- Is the CALLER premium right now? No uid argument on purpose: a parameterised
-- version would let any signed-in user probe anyone else's tier. security
-- definer because profiles' RLS only exposes the caller's own row anyway, and
-- the policy below has to evaluate this during an insert check.
create or replace function public.is_premium()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select premium_until > now() from public.profiles where id = auth.uid()), false)
$$;

revoke execute on function public.is_premium() from public;
grant execute on function public.is_premium() to authenticated;

comment on function public.is_premium() is
  'Whether the calling user has an active profiles.premium_until. Argument-free so it can only ever report the caller''s own tier.';

create table if not exists public.live_runs (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  status      text not null default 'live' check (status in ('live', 'paused', 'ended')),
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  points      jsonb not null default '[]'::jsonb,  -- simplified [[lat,lng,t,alt] | null, ...]
  stats       jsonb not null default '{}'::jsonb   -- {km, durationSec, avgPace, curPace}
);

comment on table public.live_runs is
  'In-progress run broadcast to the runner''s own other sessions. One row per user, deleted when the run ends. Insert requires premium; update/delete deliberately do not (see the policies).';

-- Server-stamped freshness. The watcher decides "signal lost" from this column,
-- so it must not be a client-supplied value: a phone with a skewed clock would
-- otherwise look permanently stale (or permanently fresh).
create or replace function public.live_runs_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists live_runs_touch on public.live_runs;
create trigger live_runs_touch
  before insert or update on public.live_runs
  for each row execute function public.live_runs_touch();

alter table public.live_runs enable row level security;

-- RLS filters rows; it does not grant the table itself. (Mirrors run_routes.)
grant select, insert, update, delete on public.live_runs to authenticated;
grant all on public.live_runs to service_role;

drop policy if exists "live_runs read own" on public.live_runs;
create policy "live_runs read own"
  on public.live_runs for select to authenticated using (auth.uid() = user_id);

-- The premium gate, and the ONLY place it appears: starting a broadcast is the
-- privileged act.
drop policy if exists "live_runs insert own" on public.live_runs;
create policy "live_runs insert own"
  on public.live_runs for insert to authenticated
  with check (auth.uid() = user_id and public.is_premium());

-- Update and delete stay own-row-only WITHOUT the premium check on purpose: an
-- entitlement that lapses mid-run must not strand a live row that the runner can
-- no longer update or clean up. The insert gate already decided who may start.
--
-- This asymmetry is only reachable if the CLIENT writes the two paths
-- separately. An upsert is INSERT ... ON CONFLICT DO UPDATE, and Postgres checks
-- an INSERT policy's WITH CHECK for every row *proposed* for insertion, whether
-- or not it ends up inserted — so an upsert is premium-gated here too, and a
-- lapse mid-run would 42501 the run off the air. src/live/publisher.ts therefore
-- opens a broadcast with insert() and continues it with update(). Keep it that way.
drop policy if exists "live_runs update own" on public.live_runs;
create policy "live_runs update own"
  on public.live_runs for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "live_runs delete own" on public.live_runs;
create policy "live_runs delete own"
  on public.live_runs for delete to authenticated using (auth.uid() = user_id);

-- Push changes to watching sessions instead of making them poll. The client
-- falls back to a 30s poll when the channel can't be established, so this is an
-- optimisation, not a requirement — hence the guard rather than a hard failure
-- on a project without the default publication.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_runs'
     )
  then
    alter publication supabase_realtime add table public.live_runs;
  end if;
end
$$;
