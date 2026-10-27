-- Product metrics for the maintainer: one jsonb of AGGREGATES only (no emails,
-- no ids, no per-user rows), read by the admin-metrics edge function for the
-- weekly digest. Definer because it counts auth.users; callable by service_role
-- alone. Windows: "7d" is the last 7 days, "prev7d" the 7 before. Run dates are
-- the runner's own YYYY-MM-DD strings, compared as text so a malformed one is
-- skipped rather than failing the whole report. docs/product-metrics.md.

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
    )
  )
  from bounds b;
$$;

revoke execute on function public.admin_metrics() from public, anon, authenticated;
grant execute on function public.admin_metrics() to service_role;
