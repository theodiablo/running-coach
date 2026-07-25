-- Running Coach — saved favourite loop routes (route-finder Phase 4).
--
-- A *suggested* loop is ephemeral client memory and is never stored. When a user
-- explicitly stars one to reuse later, it lands here — a table SEPARATE from
-- run_routes on purpose: run_routes holds RECORDED traces (a run that happened),
-- while saved_routes holds PLANNED geometry (a route to run). Keeping them apart
-- means a planned loop can never be mistaken for a logged run, and deleting a run
-- never touches a saved favourite. RLS mirrors run_routes: the publishable key is
-- public, these policies are the real boundary.

create table if not exists public.saved_routes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  label       text,                                 -- user-facing name (nullable)
  points      jsonb not null,                       -- [[lat,lng,alt],...] planned geometry
  km          double precision not null default 0,  -- measured length
  elevation   double precision not null default 0,  -- measured gain (m)
  created_at  timestamptz not null default now()
);

create index if not exists saved_routes_user_id_idx on public.saved_routes (user_id, created_at desc);

alter table public.saved_routes enable row level security;

-- Base table privileges for the authenticated role. RLS policies filter rows but
-- do NOT grant access to the table itself. (Mirrors run_routes.)
grant select, insert, update, delete on public.saved_routes to authenticated;
grant all on public.saved_routes to service_role;

drop policy if exists "saved_routes read own" on public.saved_routes;
create policy "saved_routes read own"
  on public.saved_routes for select to authenticated using (auth.uid() = user_id);

drop policy if exists "saved_routes insert own" on public.saved_routes;
create policy "saved_routes insert own"
  on public.saved_routes for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "saved_routes update own" on public.saved_routes;
create policy "saved_routes update own"
  on public.saved_routes for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "saved_routes delete own" on public.saved_routes;
create policy "saved_routes delete own"
  on public.saved_routes for delete to authenticated using (auth.uid() = user_id);
