-- Sign in with Apple refresh tokens, kept only so account deletion can revoke
-- the grant (App Store guideline 5.1.1(v)). One row per client the grant was
-- issued to (bundle id for the native sheet, Services ID for the browser flow),
-- since a token can only be revoked under its own client. Secret credentials:
-- service-role-only, written and read by the apple-auth edge function alone.

create table if not exists public.apple_auth_grants (
  user_id       uuid not null references auth.users(id) on delete cascade,
  client_id     text not null,
  refresh_token text not null,
  updated_at    timestamptz not null default now(),
  primary key (user_id, client_id)
);

alter table public.apple_auth_grants enable row level security;
revoke all on public.apple_auth_grants from anon, authenticated;
grant all on public.apple_auth_grants to service_role;
