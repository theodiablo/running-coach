-- Post-run share card counter: daily totals per combination of enum values, never one row per
-- event, so no row has an instant or an order that a request log could match to its caller.
-- It counts every runner without consent: docs/telemetry.md ("Non-personal server counters").
-- What each value means and the digest's ratios: docs/share-card.md ("Analytics").

create table public.share_card_counts (
  day         date not null,
  event       text not null check (event in ('opened', 'shared', 'saved', 'closed')),
  entry       text not null check (entry in ('finish', 'detail')),
  preselected text not null check (preselected in ('route', 'number', 'week')),
  chosen      text check (chosen in ('route', 'number', 'week')),
  platform    text not null check (platform in ('web', 'ios', 'android')),
  first_share boolean,
  n           bigint not null default 0 check (n >= 0),
  check ((event = 'opened') = (chosen is null)),
  check ((event = 'opened') = (first_share is null)),
  unique nulls not distinct (day, event, entry, preselected, chosen, platform, first_share)
);

comment on table public.share_card_counts is
  'Daily share builder totals (opens, hand-offs, closes) per enum combination. Non-personal: no id, no instant, no order. Written only by share_card_count(); read by admin_metrics().';

alter table public.share_card_counts enable row level security;
revoke all on public.share_card_counts from anon, authenticated;

-- Definer: the caller may add one to a total but never read, write or order the rows.
-- Signed-in callers only; the day is the server's UTC day.
create or replace function public.share_card_count(
  p_event text, p_entry text, p_preselected text, p_chosen text, p_platform text, p_first_share boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    return;
  end if;
  insert into public.share_card_counts as c (day, event, entry, preselected, chosen, platform, first_share, n)
  values ((pg_catalog.now() at time zone 'UTC')::date, p_event, p_entry, p_preselected, p_chosen, p_platform, p_first_share, 1)
  on conflict (day, event, entry, preselected, chosen, platform, first_share)
  do update set n = c.n + 1;
end;
$$;

revoke execute on function public.share_card_count(text, text, text, text, text, boolean) from public, anon;
grant execute on function public.share_card_count(text, text, text, text, text, boolean) to authenticated;

-- admin_metrics() as of 20261109194500_live_broadcasts, plus the 'share_card' section.
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
  ),
  -- `kept`: the hand-off (or the close) was on the style the builder pre-selected.
  share_counts as (
    select c.day, c.event, c.entry, c.platform, c.preselected, c.chosen, c.first_share, c.n,
      c.chosen = c.preselected as kept
    from public.share_card_counts c
  ),
  -- A visit that shared = its first hand-off; one that didn't = its `closed` count.
  -- Counts are per day, so '7d' is the 7 completed UTC days: weekly digests tile, none is lost.
  share_windows as (
    select w.name, jsonb_build_object(
      'opened', jsonb_build_object(
        'finish', coalesce(sum(e.n) filter (where e.event = 'opened' and e.entry = 'finish'), 0),
        'detail', coalesce(sum(e.n) filter (where e.event = 'opened' and e.entry = 'detail'), 0)
      ),
      'opened_by_platform', (
        select coalesce(jsonb_object_agg(platform, n), '{}'::jsonb)
        from (
          select o.platform, sum(o.n) n from share_counts o
          where o.event = 'opened' and (w.name = 'all' or (o.day >= k.d0 - 7 and o.day < k.d0))
          group by 1
        ) x
      ),
      'shared', coalesce(sum(e.n) filter (where e.event = 'shared'), 0),
      'saved', coalesce(sum(e.n) filter (where e.event = 'saved'), 0),
      'kept', jsonb_build_object(
        'shared', coalesce(sum(e.n) filter (where e.event in ('shared', 'saved') and e.first_share and e.kept), 0),
        'closed', coalesce(sum(e.n) filter (where e.event = 'closed' and e.kept), 0)
      ),
      'changed', jsonb_build_object(
        'shared', coalesce(sum(e.n) filter (where e.event in ('shared', 'saved') and e.first_share and not e.kept), 0),
        'closed', coalesce(sum(e.n) filter (where e.event = 'closed' and not e.kept), 0)
      ),
      -- Every hand-off, "preselected>chosen".
      'handoffs', (
        select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
        from (
          select h.preselected || '>' || h.chosen k, sum(h.n) n from share_counts h
          where h.event in ('shared', 'saved') and (w.name = 'all' or (h.day >= k.d0 - 7 and h.day < k.d0))
          group by 1
        ) x
      )
    ) as v
    from (values ('7d'), ('all')) w(name)
    cross join (select (pg_catalog.now() at time zone 'UTC')::date as d0) k
    left join share_counts e on (w.name = 'all' or (e.day >= k.d0 - 7 and e.day < k.d0))
    group by w.name, k.d0
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
    ),
    'share_card', jsonb_build_object(
      'since', (select min(day) from share_counts),
      '7d', (select v from share_windows where name = '7d'),
      'total', (select v from share_windows where name = 'all')
    )
  )
  from bounds b;
$$;

revoke execute on function public.admin_metrics() from public, anon, authenticated;
grant execute on function public.admin_metrics() to service_role;
