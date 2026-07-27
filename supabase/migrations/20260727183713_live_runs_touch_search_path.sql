-- Pin the search_path of the live_runs updated_at trigger.
--
-- Follow-up to 20260727135028 (append-only: that version is applied, so the fix
-- lands here rather than by editing it). Supabase's security advisor flagged
-- `live_runs_touch` as having a role-mutable search_path.
--
-- This is not only lint hygiene. The whole point of the trigger is that
-- `updated_at` is SERVER truth: the watcher decides "signal lost" from it, and a
-- client-supplied value would let a skewed — or dishonest — clock make a run
-- look permanently fresh. With a mutable search_path, `now()` is resolvable to
-- something other than pg_catalog.now(), which hands that column back to the
-- caller the trigger exists to take it away from. Empty search_path closes it;
-- pg_catalog is still searched implicitly, so now() keeps resolving.
create or replace function public.live_runs_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
