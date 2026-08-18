-- Running Coach — live run sharing is no longer premium-gated.
--
-- Drops the `public.is_premium()` check from the live_runs INSERT policy
-- (added in 20260727135028). Update/delete were already own-row-only without
-- it, so this makes insert consistent with them: any signed-in user may start
-- a broadcast of their own run, same as they may continue or end one.
--
-- is_premium() itself is left in place — it backs premium checks elsewhere
-- (guided workouts, route finder) that are unaffected by this change.

drop policy if exists "live_runs insert own" on public.live_runs;
create policy "live_runs insert own"
  on public.live_runs for insert to authenticated
  with check (auth.uid() = user_id);

comment on table public.live_runs is
  'In-progress run broadcast to the runner''s own other sessions, and to anyone holding a share link. One row per user, deleted when the run ends. Free feature — no premium gate.';
