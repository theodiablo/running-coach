-- Running Coach — the standing watch link (v4 of live sharing).
--
-- v2 minted a share token per run, CLIENT-side, into `live_runs.share_token`
-- and let it die with the row. That made the link per-run by construction, at
-- the cost of re-sending it before every run. This makes the address durable
-- and revocable instead, which is only safe once the token stops being a
-- column the client writes:
--
--   * `live_runs.share_token` is client-writable with a table-wide unique
--     index, so someone handed a link can squat that token on their OWN row at
--     any moment the runner's row doesn't exist (which is most of the day). For
--     a token that dies in an hour that costs a re-share. For a durable address
--     it is a permanent denial AND a spoof: everyone holding the link would
--     watch the SQUATTER's run under an address they trust.
--   * So the token moves here, where the claim is permanent and first-come.
--     `live_runs` keeps only `share_public` — a boolean carries no namespace to
--     squat.
--
-- Retired tokens are kept FOREVER as tombstones. A freed token could be
-- re-claimed by someone still holding the old link, which is the same spoof
-- through a different door; a row that exists but is revoked must resolve to
-- nothing, never fall through to anything else.

create table if not exists public.live_share_tokens (
  -- The capability itself, so uniqueness is the primary key. 128 bits of
  -- base64url, minted by the client's CSPRNG (src/live/shareLink.ts). Shape
  -- enforced rather than trusted: a client that "simplified" this to something
  -- short or predictable would silently make its own runs findable.
  token       text primary key check (token ~ '^[A-Za-z0-9_-]{22,64}$'),
  -- Nullable, and ON DELETE SET NULL rather than CASCADE: deleting an account
  -- must not free that account's tokens for re-claim. The tombstone outlives
  -- the owner; `live-watch` requires a non-null user_id.
  user_id     uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

comment on table public.live_share_tokens is
  'Durable capability tokens for the public /watch/:token page — one active per user, retired ones kept forever as tombstones so a token can never be re-claimed. Read publicly only through the live-watch edge function (service role); there is deliberately no anon policy.';

-- One live address per runner. Partial, so retired rows fall out of it and the
-- next mint is free to take the slot.
create unique index if not exists live_share_tokens_active_key
  on public.live_share_tokens (user_id) where revoked_at is null;

-- Covers the foreign key (the advisor's unindexed_foreign_keys) and the
-- ON DELETE SET NULL sweep. The partial index above does not: this table grows
-- forever by design, so neither may become a seq scan.
create index if not exists live_share_tokens_user_id_idx
  on public.live_share_tokens (user_id);

alter table public.live_share_tokens enable row level security;

-- Explicit in BOTH directions. `auto_expose_new_tables` is unset
-- (supabase/config.toml), so a new public table gets no grants on the hosted
-- project and GRANT ALL on the local stack — the posture has to be stated or
-- the privilege set differs between what we test and what we ship.
--
-- Note what is NOT granted: no update, no delete, ever. Retiring a token
-- happens only inside rotate_share_link() below, so "a tombstone is forever"
-- is structural rather than a policy anyone has to reason about.
revoke all on public.live_share_tokens from anon, authenticated;
grant select, insert (user_id, token) on public.live_share_tokens to authenticated;
grant all on public.live_share_tokens to service_role;

drop policy if exists "live_share_tokens read own" on public.live_share_tokens;
create policy "live_share_tokens read own"
  on public.live_share_tokens for select to authenticated using (auth.uid() = user_id);

-- First creation is a single statement, so it needs no function: atomic on its
-- own, and a 23505 tells the client which retry it is (the active-row index
-- means another device got there first — re-read; the primary key means bad
-- luck — re-mint).
drop policy if exists "live_share_tokens claim own" on public.live_share_tokens;
create policy "live_share_tokens claim own"
  on public.live_share_tokens for insert to authenticated with check (auth.uid() = user_id);

-- Rotation is the one operation that has to be two statements at once, and
-- PostgREST gives every request its own transaction — so this is the only
-- place a function is the difference between correct and not. Revoke-then-
-- insert from the client can strand an account with no active link; here they
-- commit together or not at all.
--
-- `security invoker`: it runs under the caller's own RLS and column grants and
-- grants nothing the caller doesn't already have. It exists for atomicity, not
-- privilege. The new token still comes from the client's CSPRNG — the server
-- decides ordering, never the bytes.
create or replace function public.rotate_share_link(p_new_token text)
returns public.live_share_tokens
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.live_share_tokens;
begin
  -- Tombstones are kept forever, so the ledger is an unbounded authenticated
  -- write primitive without a ceiling. 100 replacements is far past any real
  -- use and turns an insert-revoke loop into an error.
  if (select count(*) from public.live_share_tokens where user_id = auth.uid()) >= 100 then
    raise exception 'share link limit reached' using errcode = 'P0001';
  end if;

  update public.live_share_tokens
     set revoked_at = pg_catalog.now()
   where user_id = auth.uid() and revoked_at is null;

  insert into public.live_share_tokens (user_id, token)
       values (auth.uid(), p_new_token)
    returning * into v_row;

  return v_row;
end;
$$;

comment on function public.rotate_share_link(text) is
  'Retire the caller''s active share token and claim a new one, in one transaction. security invoker: exists for atomicity, not privilege.';

revoke all on function public.rotate_share_link(text) from public, anon;
grant execute on function public.rotate_share_link(text) to authenticated;

-- The per-run public opt-in, replacing the client-written token on this table.
-- Default false and written explicitly by the client: a row opened by an older
-- bundle (which knows nothing about the standing link) must never light one up.
alter table public.live_runs
  add column if not exists share_public boolean not null default false;

comment on column public.live_runs.share_public is
  'Whether this run is readable through the runner''s standing share link. False (the default) means the broadcast reaches the runner''s own sessions only — which is also what a row written by a pre-v4 client reads as.';

comment on column public.live_runs.share_token is
  'LEGACY (pre-v4): the per-run client-minted token. Superseded by public.live_share_tokens + share_public; live-watch still resolves it for links minted by older bundles. Retire it, and revoke the write, once min_supported_version clears the last bundle that mints one.';
