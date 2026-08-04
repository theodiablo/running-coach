-- Security-review hardening (2026-08-04), three independent fixes:
--
-- 1. Drop profiles.email entirely. The app and edge functions read email from
--    the auth session (auth.users), never from profiles, so the mirror was
--    dead weight with a real attack on it: `authenticated` held a column
--    UPDATE grant on its own row, and the column is UNIQUE, so any user could
--    squat an arbitrary address — the sign-up / email-change trigger then hit
--    the unique violation and rolled the victim's auth write back, blocking
--    that address for good. Admin lookups join auth.users instead
--    (docs/monetization.md).
--
-- 2. Freeze verified race-catalogue entries. The update/delete policies only
--    checked created_by, so a contributor could rewrite (via un-verifying) or
--    delete an admin-verified race that every user sees — deletion cascading
--    away its editions. Verified rows are now maintainer-only (service role).
--
-- 3. Revoke TRUNCATE/REFERENCES/TRIGGER from client roles. Supabase's default
--    GRANT ALL left them on every table; TRUNCATE in particular is not subject
--    to RLS. Nothing client-side ever used them (PostgREST exposes none), so
--    this is pure least-privilege, made durable for future tables via default
--    privileges.

-- ── 1. profiles.email ──────────────────────────────────────────────
drop trigger if exists on_auth_user_email_updated on auth.users;
drop function if exists public.handle_user_email_updated();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

alter table public.profiles drop column if exists email;

-- ── 2. verified catalogue entries are immutable to their contributor ─
drop policy if exists "races update own unverified" on public.races;
create policy "races update own unverified"
  on public.races for update to authenticated
  using (auth.uid() = created_by and not verified)
  with check (auth.uid() = created_by and not verified);

drop policy if exists "races delete own" on public.races;
drop policy if exists "races delete own unverified" on public.races;
create policy "races delete own unverified"
  on public.races for delete to authenticated
  using (auth.uid() = created_by and not verified);

drop policy if exists "race_editions update own unverified" on public.race_editions;
create policy "race_editions update own unverified"
  on public.race_editions for update to authenticated
  using (auth.uid() = created_by and not verified)
  with check (auth.uid() = created_by and not verified);

drop policy if exists "race_editions delete own" on public.race_editions;
drop policy if exists "race_editions delete own unverified" on public.race_editions;
create policy "race_editions delete own unverified"
  on public.race_editions for delete to authenticated
  using (auth.uid() = created_by and not verified);

-- ── 3. strip non-DML table privileges from client roles ─────────────
revoke truncate, references, trigger
  on all tables in schema public from anon, authenticated;
alter default privileges in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;
