-- Running Coach — race field, PR 1: opt-in public name, per-race membership,
-- and the one cross-user read (a count). Design: docs/race-field.md.

-- ── profiles.public_name ───────────────────────────────────────────
-- Shape is the constraint, so it holds for every writer. Escapes, never raw
-- invisible characters; \y is the word boundary in a Postgres regex.
alter table public.profiles add column if not exists public_name text;

alter table public.profiles drop constraint if exists profiles_public_name_shape;
alter table public.profiles add constraint profiles_public_name_shape check (
  public_name is null or (
    char_length(public_name) between 2 and 24
    and public_name !~ '^[[:space:]\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]|[[:space:]\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]$'
    and public_name !~ '[[:space:]\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]{2,}'
    and public_name !~ '[[:cntrl:]]'
    and public_name !~ '[\u00AD\u034F\u061C\u115F\u1160\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\u3164\uFE00-\uFE0F\uFEFF\uFFA0\U000E0000-\U000E007F]'
    and public_name !~* '(https?:|www\.|://|@|\.(com|net|org|io|fr|es)\y)'
    and public_name ~ '[[:alpha:]]'
  )
);

-- The owner writes this one column of their own row ("profiles update own");
-- premium_until/premium_since stay ungranted.
grant update (public_name) on public.profiles to authenticated;

comment on column public.profiles.public_name is
  'Opt-in name other runners see in a race field the runner chose to appear in by name. Null = off. Read cross-user only through race_field().';

-- ── race_field_members ─────────────────────────────────────────────
-- One row = one runner who chose to appear in that edition's field. "Not this
-- time" stores nothing.
create table if not exists public.race_field_members (
  user_id     uuid not null references auth.users(id) on delete cascade,
  edition_id  text not null references public.race_editions(id) on delete cascade,
  visibility  text not null check (visibility in ('named', 'count')),
  goal_sec    integer check (goal_sec is null or goal_sec between 600 and 86400),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, edition_id),
  constraint race_field_members_goal_named check (goal_sec is null or visibility = 'named')
);
create index if not exists race_field_members_edition_idx on public.race_field_members (edition_id);

alter table public.race_field_members enable row level security;

-- Explicit both ways: hosted gives a new table no grants, the local stack GRANT ALL.
revoke all on public.race_field_members from anon, authenticated;
grant select, delete on public.race_field_members to authenticated;
grant insert (user_id, edition_id, visibility, goal_sec) on public.race_field_members to authenticated;
grant update (visibility, goal_sec) on public.race_field_members to authenticated;

drop policy if exists "race_field_members own" on public.race_field_members;
create policy "race_field_members own"
  on public.race_field_members for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Verified editions only (a contributor can't move or close a field under its
-- members), and at most 30 upcoming fields per runner. INVOKER is load-bearing:
-- the count sees only the caller's rows, so its error reveals nothing about anyone else.
create or replace function public.race_field_members_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.race_editions e
    where e.id = new.edition_id and e.verified and e.date >= current_date
  ) then
    raise exception 'race field closed' using errcode = 'P0001';
  end if;
  if (
    select count(*) from public.race_field_members m
    join public.race_editions e on e.id = m.edition_id
    where m.user_id = new.user_id and m.edition_id <> new.edition_id and e.date >= current_date
  ) >= 30 then
    raise exception 'race field limit reached' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.race_field_members_guard() from public, anon, authenticated;

comment on function public.race_field_members_guard() is
  'Refuses a membership on an unverified or past edition, and a 31st upcoming one (a duplicate of an existing one is left to the primary key, so it reads as 23505). SECURITY INVOKER on purpose: the count sees only the caller''s own rows, so the error can never reveal another account''s memberships.';

drop trigger if exists race_field_members_guard on public.race_field_members;
create trigger race_field_members_guard
  before insert on public.race_field_members
  for each row execute function public.race_field_members_guard();

create or replace function public.race_field_members_touch()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.race_field_members_touch() from public, anon, authenticated;

drop trigger if exists race_field_members_touch on public.race_field_members;
create trigger race_field_members_touch
  before update on public.race_field_members
  for each row execute function public.race_field_members_touch();

-- ── race_field(): the one cross-user read ──────────────────────────
-- DEFINER because it counts other runners' rows, which RLS hides from the caller
-- (accepted lint 0029, like delete_my_account). One argument, no filters, and one
-- response shape for "unknown", "past", "unverified" and "fewer than 3 others".
create or replace function public.race_field(p_edition_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_date   date;
  v_others integer;
  v_joined boolean;
begin
  if v_uid is null then
    raise exception 'race_field: no authenticated user' using errcode = '28000';
  end if;

  select e.date into v_date from public.race_editions e
    where e.id = p_edition_id and e.verified and length(p_edition_id) <= 200;
  select exists (
    select 1 from public.race_field_members m
    where m.user_id = v_uid and m.edition_id = p_edition_id
  ) into v_joined;
  select count(*) into v_others from public.race_field_members m
    where m.edition_id = p_edition_id and m.user_id <> v_uid;

  if v_date is null or v_date < current_date - 1 or v_others < 3 then
    return jsonb_build_object('open', false, 'joined', v_joined);
  end if;

  return jsonb_build_object(
    'open', true,
    'joined', v_joined,
    'count', v_others + (case when v_joined then 1 else 0 end)
  );
end;
$$;

revoke all on function public.race_field(text) from public, anon;
grant execute on function public.race_field(text) to authenticated;

comment on function public.race_field(text) is
  'How many app runners joined an edition''s field: nothing until 3 others have, one closed shape otherwise. The only cross-user read of runner data (docs/race-field.md). SECURITY DEFINER by necessity, client-callable by design; returns no ids, names or dates.';
