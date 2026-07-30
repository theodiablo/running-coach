-- Running Coach — generic cloud-integration credentials + webhook staging.
--
-- One table for every cloud provider's OAuth credentials (Polar today, Suunto
-- next, COROS later) instead of a table per provider: a single place to check
-- what a user has connected and to act on it. Access tokens are SECRET
-- credentials, so all of this is service-role-only, mirroring polar_tokens:
-- RLS ON with NO grants or policies for `authenticated` (plus an explicit
-- revoke so the posture survives the auto_expose_new_tables transition — see
-- supabase/config.toml). Only edge functions ever touch these rows.
--
-- Existing polar_tokens rows are COPIED here (not moved): the deployed
-- polar-import function reads polar_tokens until its rewrite deploys, and
-- migrations are pushed by hand before the merge that deploys functions. The
-- rewritten polar-import dual-reads (this table first, polar_tokens fallback);
-- a later migration drops polar_tokens once verified live.

create table if not exists public.integration_connections (
  user_id          uuid not null references auth.users(id) on delete cascade,
  provider         text not null,
  -- The provider-side account id (Polar AccessLink user id, Suunto username).
  -- Only unique per provider; webhook lookups must always filter on provider.
  external_user_id text not null,
  access_token     text not null,
  -- Null refresh_token/expires_at = the provider issues non-expiring tokens
  -- (Polar). Null expires_at means NEVER EXPIRES, not "expired" — a token
  -- refresher must return such rows untouched.
  refresh_token    text,
  expires_at       timestamptz,
  -- Monotone sync watermark (epoch ms of the last fully-processed listed
  -- workout; 0 = full-history backfill pending). A real column, not jsonb:
  -- concurrent acks go through ack_integration_cursor's greatest() so a stale
  -- ack can never rewind it.
  sync_cursor      bigint not null default 0,
  -- Non-contended provider extras (needs_reauth flag, overlap-check stamp...).
  sync_state       jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (user_id, provider)
);

-- Webhook ingestion path: look up who a provider-side account belongs to.
create index if not exists integration_connections_ext_idx
  on public.integration_connections (provider, external_user_id);

alter table public.integration_connections enable row level security;
revoke all on public.integration_connections from anon, authenticated;
grant all on public.integration_connections to service_role;

-- Workouts announced by a provider webhook, staged until the app's next sync
-- drains them. Rows are small (key + the few summary fields sync uses) and
-- deleted on ack/disconnect; a sweep in the sync path expires leftovers.
create table if not exists public.integration_staged_workouts (
  user_id      uuid not null references auth.users(id) on delete cascade,
  provider     text not null,
  external_key text not null,
  payload      jsonb,
  created_at   timestamptz not null default now(),
  primary key (user_id, provider, external_key)
);

alter table public.integration_staged_workouts enable row level security;
revoke all on public.integration_staged_workouts from anon, authenticated;
grant all on public.integration_staged_workouts to service_role;

-- Atomic cursor advance (service role only). supabase-js .update() can't
-- express `greatest(sync_cursor, $1)`, and a read-modify-write from two
-- concurrent syncs (phone + tablet) could rewind the watermark and re-serve
-- pages. Monotone by construction instead.
create or replace function public.ack_integration_cursor(p_user_id uuid, p_provider text, p_cursor bigint)
returns bigint language sql security definer set search_path = public as $$
  update public.integration_connections
     set sync_cursor = greatest(sync_cursor, p_cursor),
         updated_at = now()
   where user_id = p_user_id and provider = p_provider
  returning sync_cursor;
$$;
revoke execute on function public.ack_integration_cursor(uuid, text, bigint) from anon, authenticated, public;
grant execute on function public.ack_integration_cursor(uuid, text, bigint) to service_role;

-- Per-user daily detail-download counter (mirrors route_suggest_usage): cloud
-- APIs are metered by an app-wide key, so one runaway client must not be able
-- to burn the shared quota. Generous limits enforced in the edge functions.
create table if not exists public.integration_sync_usage (
  user_id  uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  day      date not null,
  count    integer not null default 0,
  primary key (user_id, provider, day)
);

create or replace function public.increment_integration_sync_usage(p_user_id uuid, p_provider text, p_day date)
returns integer language sql security definer set search_path = public as $$
  insert into public.integration_sync_usage (user_id, provider, day, count)
  values (p_user_id, p_provider, p_day, 1)
  on conflict (user_id, provider, day) do update set count = integration_sync_usage.count + 1
  returning count;
$$;
revoke execute on function public.increment_integration_sync_usage(uuid, text, date) from anon, authenticated, public;
grant execute on function public.increment_integration_sync_usage(uuid, text, date) to service_role;

alter table public.integration_sync_usage enable row level security;
revoke all on public.integration_sync_usage from anon, authenticated;
grant all on public.integration_sync_usage to service_role;

-- Adopt the existing Polar connections. Copy, don't move — see header.
insert into public.integration_connections
  (user_id, provider, external_user_id, access_token, created_at, updated_at)
select user_id, 'polar', polar_user_id, access_token, created_at, updated_at
  from public.polar_tokens
on conflict (user_id, provider) do nothing;
