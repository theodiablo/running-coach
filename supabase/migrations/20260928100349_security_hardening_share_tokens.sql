-- Running Coach — security hardening from the 2026-09 review.

-- 1. A share token names ONE owner across both stores. `live-watch` reads the
-- ledger before the legacy `live_runs.share_token` column, and both are
-- client-writable, so without this a viewer could claim a runner's legacy token
-- into the ledger (or a v4 token into the column) and serve their own run under
-- the victim's link. Definer: the check must see other users' rows.
create or replace function public.share_token_owner_conflict(p_token text, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.live_runs where share_token = p_token and user_id is distinct from p_user_id)
      or exists (select 1 from public.live_share_tokens where token = p_token and user_id is distinct from p_user_id);
$$;
revoke all on function public.share_token_owner_conflict(text, uuid) from public, anon, authenticated;

create or replace function public.share_token_no_foreign_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Column name as a trigger argument: plpgsql resolves every `new.<field>` it
  -- sees, so one function can't name both tables' columns directly.
  v_token text := pg_catalog.to_jsonb(new) ->> tg_argv[0];
begin
  if v_token is not null and public.share_token_owner_conflict(v_token, new.user_id) then
    raise exception 'share token unavailable' using errcode = '23505';
  end if;
  return new;
end;
$$;
revoke all on function public.share_token_no_foreign_claim() from public, anon, authenticated;

drop trigger if exists live_share_tokens_no_foreign_claim on public.live_share_tokens;
create trigger live_share_tokens_no_foreign_claim
  before insert on public.live_share_tokens
  for each row execute function public.share_token_no_foreign_claim('token');

drop trigger if exists live_runs_no_foreign_share_token on public.live_runs;
create trigger live_runs_no_foreign_share_token
  before insert or update of share_token on public.live_runs
  for each row execute function public.share_token_no_foreign_claim('share_token');

-- 2. The 100-token cap lived only in rotate_share_link, but retire + insert are
-- both plain REST writes, so a loop around the RPC grew tombstones without bound.
drop policy if exists "live_share_tokens claim own" on public.live_share_tokens;
create policy "live_share_tokens claim own"
  on public.live_share_tokens for insert to authenticated
  with check (
    auth.uid() = user_id
    and (select count(*) from public.live_share_tokens t where t.user_id = auth.uid()) < 100
  );

-- 3. Service-role-only definer functions: pin the empty search_path (bodies are
-- already fully qualified).
alter function public.handle_new_user() set search_path = '';
alter function public.increment_agent_usage(uuid, date) set search_path = '';
alter function public.increment_route_suggest_usage(uuid, date) set search_path = '';
alter function public.decrement_route_suggest_usage(uuid, date) set search_path = '';
alter function public.ack_integration_cursor(uuid, text, bigint) set search_path = '';
alter function public.increment_integration_sync_usage(uuid, text, date) set search_path = '';

-- 4. Contributed race URLs are rendered as links for every user: web links only.
alter table public.races drop constraint if exists races_url_web_only;
alter table public.races add constraint races_url_web_only
  check (url is null or url ~* '^https?://');
