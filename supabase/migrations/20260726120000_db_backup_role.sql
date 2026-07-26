-- Dedicated login role for the daily backup job (.github/workflows/db-backup.yml).
--
-- The job only ever reads, so it has no business holding the postgres
-- credential: postgres owns every table in public and can drop them. This role
-- reads everything and writes nothing, so a leaked backup credential can
-- exfiltrate but not destroy.
--
-- BYPASSRLS is required, not a nicety. Every table in public has row level
-- security enabled and this role owns none of them, so without it
-- `pg_dump --data-only` emits each COPY header with zero rows underneath and
-- the backup silently contains nothing. db-backup.yml counts the dumped
-- app_state rows specifically to catch that.
--
-- No password is set here, on purpose: it would be committed to git. Set it out
-- of band, once, and put the resulting URI in the SUPABASE_DB_URL secret:
--
--   alter role db_backup with password '<generated>';
--
-- A role with no password cannot authenticate, so this migration is inert until
-- that runs. See docs/backups.md.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'db_backup') then
    create role db_backup with login;
  end if;
end
$$;

-- Applied unconditionally so the role converges to the intended shape even if a
-- previous run left it partially configured. The attributes not named here
-- (nosuperuser, nocreatedb, nocreaterole, noreplication, inherit) are already
-- the CREATE ROLE defaults, and are left alone so this cannot fail on a
-- privilege it is not allowed to change.
alter role db_backup with login bypassrls connection limit 10;

grant pg_read_all_data to db_backup;
