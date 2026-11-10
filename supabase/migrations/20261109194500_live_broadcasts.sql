-- Live-sharing metrics. `live_runs` holds one row per user and deletes it when the run ends, so it
-- keeps no history: this ledger keeps one row per broadcast, plus which public-page loads saw it live.
-- Aggregates only leave through admin_metrics(). docs/product-metrics.md, docs/live-sharing.md.

create table if not exists public.live_broadcasts (
  id            bigint generated always as identity primary key,
  -- SET NULL, not CASCADE: a deleted account's past broadcasts still count, unattributed.
  user_id       uuid references auth.users(id) on delete set null,
  started_at    timestamptz not null,
  shared_public boolean not null default false,
  created_at    timestamptz not null default now()
);

comment on table public.live_broadcasts is
  'One row per live-run broadcast (live_runs keeps none after the run). Written by trigger, read by admin_metrics() and live-watch (service role).';

-- One broadcast = one (runner, run start): the publisher's delete-then-reinsert of the same run
-- re-fires the insert trigger and must not count twice. Leads with user_id, so it covers the FK.
create unique index if not exists live_broadcasts_run_key on public.live_broadcasts (user_id, started_at);
create index if not exists live_broadcasts_started_at_idx on public.live_broadcasts (started_at);

-- `viewer` is a random id the public watch page mints per page load and keeps in memory only
-- (src/live/shareLink.ts): it counts page loads, not people, and links to nothing.
create table if not exists public.live_broadcast_viewers (
  broadcast_id  bigint not null references public.live_broadcasts(id) on delete cascade,
  viewer        uuid not null,
  first_seen_at timestamptz not null default now(),
  primary key (broadcast_id, viewer)
);

comment on table public.live_broadcast_viewers is
  'Public /watch/ page loads that received a broadcast while it was live. The viewer id is random per page load, never stored on the device.';

alter table public.live_broadcasts enable row level security;
alter table public.live_broadcast_viewers enable row level security;
revoke all on public.live_broadcasts from anon, authenticated;
revoke all on public.live_broadcast_viewers from anon, authenticated;
grant all on public.live_broadcasts to service_role;
grant all on public.live_broadcast_viewers to service_role;

-- Definer: the caller is the runner (authenticated), who has no grant on the ledger. A metrics
-- failure must never fail the broadcast write it rides on, so every error is swallowed.
create or replace function public.live_broadcasts_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.live_broadcasts (user_id, started_at, shared_public)
  values (new.user_id, new.started_at, coalesce(new.share_public, false) or new.share_token is not null)
  on conflict (user_id, started_at) do update
    set shared_public = public.live_broadcasts.shared_public or excluded.shared_public;
  return new;
exception when others then
  raise warning 'live_broadcasts_record: %', sqlerrm;
  return new;
end;
$$;

revoke execute on function public.live_broadcasts_record() from public, anon, authenticated;

drop trigger if exists live_broadcasts_record on public.live_runs;
create trigger live_broadcasts_record
  after insert on public.live_runs
  for each row execute function public.live_broadcasts_record();

-- Sharing switched on mid-run. Every publish names share_public, so the WHEN keeps this to the flip.
drop trigger if exists live_broadcasts_record_share on public.live_runs;
create trigger live_broadcasts_record_share
  after update of share_public on public.live_runs
  for each row when (new.share_public is true and old.share_public is not true)
  execute function public.live_broadcasts_record();

-- Called by live-watch (service role) when it serves a live public run to a page load.
create or replace function public.live_broadcast_note_view(p_user_id uuid, p_started_at timestamptz, p_viewer uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.live_broadcast_viewers (broadcast_id, viewer)
  select b.id, p_viewer
  from public.live_broadcasts b
  where b.user_id = p_user_id and b.started_at = p_started_at
  on conflict do nothing;
$$;

revoke execute on function public.live_broadcast_note_view(uuid, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.live_broadcast_note_view(uuid, timestamptz, uuid) to service_role;

-- admin_metrics() as of 20261030220735_qr_scans, plus the 'live' section. Windows on started_at.
create or replace function public.admin_metrics()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with
  bounds as (
    select
      now() as t_now,
      now() - interval '7 days' as t_7,
      now() - interval '14 days' as t_14,
      now() - interval '30 days' as t_30,
      to_char(current_date, 'YYYY-MM-DD') as d_now,
      to_char(current_date - 7, 'YYYY-MM-DD') as d_7,
      to_char(current_date - 14, 'YYYY-MM-DD') as d_14
  ),
  runs as (
    select s.user_id, r
    from public.app_state s
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(s.data->'rc_runs') = 'array' then s.data->'rc_runs' else '[]'::jsonb end
    ) r
  ),
  runs_7d as (
    select runs.* from runs, bounds b
    where r->>'date' > b.d_7 and r->>'date' <= b.d_now
  ),
  plans as (
    select s.data->'rc_plan' p
    from public.app_state s
    where jsonb_typeof(s.data->'rc_plan') = 'object'
  ),
  rounds as (
    select ar.model, ar.input_tokens, ar.output_tokens, ar.created_at
    from public.agent_rounds ar
  ),
  tokens as (
    select
      w.name,
      coalesce(jsonb_object_agg(t.model, jsonb_build_object(
        'rounds', t.rounds, 'input', t.input, 'output', t.output
      )) filter (where t.model is not null), '{}'::jsonb) as by_model
    from (values ('7d'), ('30d'), ('all')) w(name)
    left join lateral (
      select rd.model, count(*) rounds, sum(rd.input_tokens) input, sum(rd.output_tokens) output
      from rounds rd, bounds b
      where w.name = 'all'
         or (w.name = '7d' and rd.created_at >= b.t_7)
         or (w.name = '30d' and rd.created_at >= b.t_30)
      group by rd.model
    ) t on true
    group by w.name
  ),
  broadcasts as (
    select lb.user_id, lb.started_at, lb.shared_public,
      (select count(*) from public.live_broadcast_viewers v where v.broadcast_id = lb.id) as viewers
    from public.live_broadcasts lb
  )
  select jsonb_build_object(
    'generated_at', b.t_now,
    'users', jsonb_build_object(
      'total', (select count(*) from auth.users),
      'new_7d', (select count(*) from auth.users u where u.created_at >= b.t_7),
      'new_prev7d', (select count(*) from auth.users u where u.created_at >= b.t_14 and u.created_at < b.t_7),
      'new_30d', (select count(*) from auth.users u where u.created_at >= b.t_30),
      'onboarded', (select count(*) from public.app_state s where s.data->'rc_settings'->>'onboarded' = 'true'),
      'premium', (select count(*) from public.profiles pr where pr.premium_until > b.t_now)
    ),
    -- A data save is the only server-side trace of use: sessions refresh
    -- silently, so auth's last_sign_in_at undercounts by an order of magnitude.
    'active', jsonb_build_object(
      '7d', (select count(*) from public.app_state s where s.updated_at >= b.t_7),
      'prev7d', (select count(*) from public.app_state s where s.updated_at >= b.t_14 and s.updated_at < b.t_7),
      '30d', (select count(*) from public.app_state s where s.updated_at >= b.t_30)
    ),
    'runs', jsonb_build_object(
      'total', (select count(*) from runs),
      '7d', (select count(*) from runs_7d),
      'prev7d', (select count(*) from runs where r->>'date' > b.d_14 and r->>'date' <= b.d_7),
      'runners_7d', (select count(distinct user_id) from runs_7d),
      'gps_7d', (select count(*) from runs_7d where r->>'source' = 'gps'),
      'cross_training_7d', (select count(*) from runs_7d where r->>'type' = 'OTHER'),
      'km_7d', (
        select coalesce(round(sum((r->>'km')::numeric), 1), 0) from runs_7d
        where jsonb_typeof(r->'km') = 'number' and r->>'type' is distinct from 'OTHER'
      )
    ),
    'plans', jsonb_build_object(
      'total', (select count(*) from plans),
      'upcoming_race', (select count(*) from plans where p->>'raceDate' >= b.d_now),
      'by_style', (
        select coalesce(jsonb_object_agg(style, n), '{}'::jsonb)
        from (select coalesce(p->>'style', 'balanced') style, count(*) n from plans group by 1) x
      )
    ),
    'coach', jsonb_build_object(
      'conversations_total', (select count(*) from public.agent_trajectories),
      'conversations_7d', (select count(*) from public.agent_trajectories t where t.created_at >= b.t_7),
      'conversations_prev7d', (select count(*) from public.agent_trajectories t where t.created_at >= b.t_14 and t.created_at < b.t_7),
      'users_7d', (select count(distinct t.user_id) from public.agent_trajectories t where t.created_at >= b.t_7),
      'accepted_7d', (select count(*) from public.agent_trajectories t where t.created_at >= b.t_7 and t.status = 'accepted'),
      'tokens', (select jsonb_object_agg(name, by_model) from tokens)
    ),
    'feedback', jsonb_build_object(
      'beta_7d', (select count(*) from public.beta_feedback f where f.created_at >= b.t_7),
      'beta_total', (select count(*) from public.beta_feedback),
      'coach_flags_7d', (select count(*) from public.coach_feedback f where f.created_at >= b.t_7),
      'coach_flags_total', (select count(*) from public.coach_feedback)
    ),
    'integrations', (
      select coalesce(jsonb_object_agg(provider, n), '{}'::jsonb)
      from (select ic.provider, count(*) n from public.integration_connections ic group by 1) x
    ),
    'qr', jsonb_build_object(
      '7d', (select count(*) from public.qr_scans q where q.created_at >= b.t_7),
      'prev7d', (select count(*) from public.qr_scans q where q.created_at >= b.t_14 and q.created_at < b.t_7),
      'total', (select count(*) from public.qr_scans),
      'by_platform_7d', (
        select coalesce(jsonb_object_agg(platform, n), '{}'::jsonb)
        from (select q.platform, count(*) n from public.qr_scans q where q.created_at >= b.t_7 group by 1) x
      ),
      'by_platform_total', (
        select coalesce(jsonb_object_agg(platform, n), '{}'::jsonb)
        from (select q.platform, count(*) n from public.qr_scans q group by 1) x
      ),
      'by_src_total', (
        select coalesce(jsonb_object_agg(src, n), '{}'::jsonb)
        from (select q.src, count(*) n from public.qr_scans q group by 1 order by n desc, q.src limit 20) x
      )
    ),
    'live', jsonb_build_object(
      'since', (select min(started_at) from broadcasts),
      'runs_7d', (select count(*) from broadcasts lb where lb.started_at >= b.t_7),
      'runs_prev7d', (select count(*) from broadcasts lb where lb.started_at >= b.t_14 and lb.started_at < b.t_7),
      'runners_7d', (select count(distinct lb.user_id) from broadcasts lb where lb.started_at >= b.t_7),
      'public_7d', (select count(*) from broadcasts lb where lb.started_at >= b.t_7 and lb.shared_public),
      'watched_7d', (select count(*) from broadcasts lb where lb.started_at >= b.t_7 and lb.viewers > 0),
      'watched_prev7d', (select count(*) from broadcasts lb where lb.started_at >= b.t_14 and lb.started_at < b.t_7 and lb.viewers > 0),
      'page_loads_7d', (select coalesce(sum(lb.viewers), 0) from broadcasts lb where lb.started_at >= b.t_7),
      'runs_total', (select count(*) from broadcasts),
      'watched_total', (select count(*) from broadcasts lb where lb.viewers > 0),
      'runners_with_link', (
        select count(*) from public.live_share_tokens t where t.revoked_at is null and t.user_id is not null
      )
    )
  )
  from bounds b;
$$;

revoke execute on function public.admin_metrics() from public, anon, authenticated;
grant execute on function public.admin_metrics() to service_role;
