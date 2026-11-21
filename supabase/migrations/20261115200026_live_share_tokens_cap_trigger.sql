-- Running Coach — the 100-token cap moves from the insert policy to a trigger.
--
-- A policy may not read its own table once that table's SELECT policy has a
-- subquery (42P17, infinite recursion), so the 100-token cap lives in a trigger.

drop policy if exists "live_share_tokens claim own" on public.live_share_tokens;
create policy "live_share_tokens claim own"
  on public.live_share_tokens for insert to authenticated
  with check ((select auth.uid()) = user_id);

create or replace function public.live_share_tokens_cap()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (select count(*) from public.live_share_tokens where user_id = new.user_id) >= 100 then
    raise exception 'share link limit reached' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.live_share_tokens_cap() from public, anon, authenticated;

drop trigger if exists live_share_tokens_cap on public.live_share_tokens;
create trigger live_share_tokens_cap
  before insert on public.live_share_tokens
  for each row execute function public.live_share_tokens_cap();
