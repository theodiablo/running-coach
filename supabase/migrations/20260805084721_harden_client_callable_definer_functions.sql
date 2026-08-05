-- Database-linter pass (lint 0029, authenticated_security_definer_function_executable).
--
-- The linter flags every SECURITY DEFINER function in the API-exposed `public`
-- schema that `authenticated` may call over /rest/v1/rpc/. Only two of ours
-- were: is_premium() and delete_my_account(). Everything else is already
-- service_role-only (20260614120000 revoked the implicit PUBLIC grant on the
-- trigger functions; the usage counters and live_publish_* RPCs grant EXECUTE
-- to service_role alone).
--
--   * is_premium() had no reason to be DEFINER — see below, it becomes
--     SECURITY INVOKER and the finding goes away.
--   * delete_my_account() genuinely needs it and stays; the finding is
--     accepted, and the function is tightened instead.

-- ── is_premium(): DEFINER -> INVOKER ───────────────────────────────
-- It reads one column of the caller's own profiles row, and "profiles read
-- own" (auth.uid() = id) plus the table-level SELECT grant already give
-- `authenticated` exactly that much. So the elevated context bought nothing —
-- the original comment said as much ("profiles' RLS only exposes the caller's
-- own row anyway"). As INVOKER the function can never see more than its caller
-- can, which is what makes it safe to leave callable.
--
-- Still argument-free on purpose: a parameterised version would let any signed
-- in user probe another account's tier.
--
-- The live_runs INSERT policy (`with check ... and public.is_premium()`) is
-- unaffected: policy expressions are evaluated as the querying role, which is
-- the same role that now needs the profiles SELECT — and has it.
--
-- search_path is pinned to '' (was `public`) and references are fully
-- qualified, so no schema ahead of ours can be shadowed by a caller's setting.
create or replace function public.is_premium()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    (select premium_until > now() from public.profiles where id = (select auth.uid())),
    false)
$$;

comment on function public.is_premium() is
  'Whether the calling user has an active profiles.premium_until. Argument-free so it can only ever report the caller''s own tier, and SECURITY INVOKER so it can never read past the caller''s own RLS-visible profiles row.';

-- ── delete_my_account(): stays SECURITY DEFINER ────────────────────
-- Accepted linter finding. Deleting from auth.users is the whole point of the
-- function (the cascade is what erases profiles/app_state/run_routes), the
-- client is the only caller, and `authenticated` cannot be granted write
-- access to the auth schema — DEFINER is the only way to express "a user may
-- delete themselves, and only themselves".
--
-- Two tightenings, no behaviour change for a real caller:
--   * search_path = '' with auth.users fully qualified;
--   * an explicit null-uid guard. `id = auth.uid()` already matches no row
--     when the claim is missing (null is never equal), so this changes
--     nothing today — it is a guard against a future edit turning a no-op
--     into a table-wide delete, which is the one mistake this function's
--     privileges would make catastrophic.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'delete_my_account: no authenticated user' using errcode = '28000';
  end if;
  delete from auth.users where id = v_uid;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

comment on function public.delete_my_account() is
  'Permanently deletes the CALLING user''s account (cascades to profiles, app_state, run_routes). SECURITY DEFINER by necessity — only the owner may write auth.users — and scoped to auth.uid(), so it can never touch another account. Deliberately exempt from lint 0029.';

-- ── service-role-only tables: make the deny-all explicit ───────────
-- Lint 0008 (rls_enabled_no_policy) reports these as INFO. That state is the
-- intent, not an oversight: RLS on with zero policies denies every client role
-- outright, and each table is written only by an edge function holding the
-- service role (which bypasses RLS). polar_tokens holds OAuth refresh tokens;
-- the rest are rate-limit counters and sync bookkeeping. None is ever read by
-- a browser client, so there is nothing to write a policy for.
--
-- The newer integration_* tables (20260730204228) already paired the RLS with
-- an explicit revoke. These four predate that habit and rely on the schema's
-- privileges happening to be empty. Restate it so a future `grant all on all
-- tables` can't quietly make RLS the only thing standing there.
revoke all on public.agent_usage                from anon, authenticated;
revoke all on public.contribution_notifications from anon, authenticated;
revoke all on public.polar_tokens               from anon, authenticated;
revoke all on public.route_suggest_usage        from anon, authenticated;

comment on table public.agent_usage is
  'Per-user/day coach-agent call counter. Service role only (RLS on, no policies, no client grants).';
comment on table public.contribution_notifications is
  'Dedupe ledger for race-contribution notifications. Service role only (RLS on, no policies, no client grants).';
comment on table public.polar_tokens is
  'Polar OAuth tokens. Service role only (RLS on, no policies, no client grants) — a client must never read these.';
comment on table public.route_suggest_usage is
  'Per-user/day route-suggestion call counter. Service role only (RLS on, no policies, no client grants).';
