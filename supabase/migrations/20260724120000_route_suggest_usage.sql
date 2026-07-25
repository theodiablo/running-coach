-- Running Coach — loop route-suggestion daily-limit counter.
--
-- The "Find a route" feature (supabase/functions/route-suggest) proxies a small
-- number of round-trip routing requests to openrouteservice per generation. The
-- ORS free tier is quota-bearing, so the edge function enforces a per-user daily
-- budget (ROUTE_SUGGEST_LIMIT_PER_DAY, default 30) the same way coach-agent does
-- with agent_usage: an atomic per-(user,day) counter written by the SERVICE ROLE
-- ONLY. There is no client policy at all — a user can neither read nor write this
-- table, so it can't be used to mint extra quota.

create table if not exists public.route_suggest_usage (
  user_id  uuid not null references auth.users(id) on delete cascade,
  day      date not null,
  count    integer not null default 0,
  primary key (user_id, day)
);

-- Atomic increment used by the edge function (service role), so two concurrent
-- requests can't both read count=N and write N+1. Returns the new count.
create or replace function public.increment_route_suggest_usage(p_user_id uuid, p_day date)
returns integer language sql security definer set search_path = public as $$
  insert into public.route_suggest_usage (user_id, day, count)
  values (p_user_id, p_day, 1)
  on conflict (user_id, day) do update set count = route_suggest_usage.count + 1
  returning count;
$$;
-- Service-role only: revoke the default PUBLIC execute so a client can't burn
-- quota, then grant back to the service role explicitly.
revoke execute on function public.increment_route_suggest_usage(uuid, date) from anon, authenticated, public;
grant execute on function public.increment_route_suggest_usage(uuid, date) to service_role;

alter table public.route_suggest_usage enable row level security;
-- No client policies at all — service role only (mirrors agent_usage).
grant all on public.route_suggest_usage to service_role;
