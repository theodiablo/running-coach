# Database backups

Daily logical backup of the Supabase database to S3, plus how to restore it.

Workflow: `.github/workflows/db-backup.yml`.

## Why

The whole app state is one `jsonb` row per user in `public.app_state`, and the
client replaces that blob wholesale on every write (`src/db.ts`). There is no
history table and no per-row versioning, so a bad write is unrecoverable from
inside the database.

This is not theoretical. On 2026-07-26 a signed-in user's `app_state` read was
aborted on an offline cold start; `initStore` fell back to an empty cache while
leaving the store writable, the app rendered them as a new user, and the first
write replaced 14 runs, a 16-week plan and the coach's memory with a blank
slate. It was recoverable only because the coach agent's audit log
(`agent_rounds.input_context`) happened to hold a snapshot — luck, not design.
The write path is fixed (a failed load can no longer become a write), but the
row is still the only copy of the data. Hence this job.

## What it does

Every day at 02:20 UTC (and on `workflow_dispatch`):

1. Dumps the database three ways with the Supabase CLI — `--role-only`,
   schema, and `--data-only --use-copy`. The CLI runs `pg_dump` inside a
   container built from the server's own Postgres image, so the client version
   always matches the server; plain `pg_dump` from apt is a major version
   behind and refuses to dump PG17.
2. Refuses to upload a dump that is empty, has no `CREATE TABLE`, or carries
   fewer than `MIN_APP_STATE_ROWS` rows in its `COPY public.app_state` block. A
   backup that silently contains nothing reads as success forever, which is
   worse than a loud failure. The rows are counted, not just the COPY header:
   see [Why the row count matters](#why-the-row-count-matters).
3. Uploads one tarball to
   `s3://$BACKUP_S3_BUCKET/supabase/run-app-<UTC stamp>.tar.gz` with SSE, then
   re-reads its size to confirm the object is not truncated.
4. Deletes backups older than 30 days (`RETENTION_DAYS`), **always keeping the
   7 most recent** (`MIN_KEEP`) whatever their age, and only ever touching keys
   matching its own `run-app-<stamp>.tar.gz` pattern under its own prefix.

All three knobs (`RETENTION_DAYS`, `MIN_KEEP`, `MIN_APP_STATE_ROWS`) are `env:`
at the top of the workflow.

## Setup

The job skips itself with a warning until these exist.

| Secret | What |
| --- | --- |
| `SUPABASE_DB_URL` | Session pooler URI for the `db_backup` role — see below |
| `BACKUP_S3_BUCKET` | `run-app-db-backups` |
| `AWS_BACKUP_ROLE_ARN` | `arn:aws:iam::703323013899:role/GitHub-Actions-RunApp-backup` |

### AWS

Both AWS resources are Terraform-managed in `infra/` and already exist, as are
the two secrets naming them. See `infra/README.md`.

The bucket is private and deliberately separate from `S3_BUCKET_NAME`, which is
the CloudFront origin for the site and world-readable — these dumps contain
personal health data (runs, heart rate, notes). The role is separate from the
deploy role so that permission to delete backups stays out of the path that runs
on every push to `main`, and it is scoped to the default branch, so the job
cannot be dispatched from a topic branch.

### The `db_backup` database role

The job only ever reads, so it does not use the `postgres` credential:
`postgres` owns every table in `public` and can drop them. It connects as
`db_backup`, created by
`supabase/migrations/20260726120000_db_backup_role.sql` with `LOGIN`,
`BYPASSRLS` and `pg_read_all_data` — reads everything, writes nothing.

The migration sets **no password**, because that would commit a credential to
git. Set it once, out of band, then build the secret:

```sql
alter role db_backup with password '<generated>';
```

```bash
# Session pooler URI. Take the host and port from Dashboard -> Connect ->
# Session pooler, and swap the role in both the username and the credential.
gh secret set SUPABASE_DB_URL \
  --body 'postgresql://db_backup.<project-ref>:<password>@<pooler-host>:5432/postgres'
```

Until that runs, the role cannot authenticate and the migration is inert.

Two things to get right:

- Use the **pooler** host, not `db.<ref>.supabase.co`. Direct database hostnames
  are IPv6-only and GitHub runners are IPv4-only.
- Percent-encode any special characters in the password.

### Why the row count matters

Every table in `public` has row level security enabled. `postgres` dumps them
because it owns them; any other role is subject to every policy unless it has
`BYPASSRLS`. A role without it produces this:

```
COPY public.app_state (user_id, data, updated_at) FROM stdin;
\.
```

A valid dump, structurally. Zero rows. The original guard tested only for the
presence of the `COPY public.app_state` line, which that output still satisfies,
so it would have uploaded an empty backup and reported success — the exact
failure this job exists to prevent, reintroduced through the back door. Hence
counting the rows between the header and the `\.` terminator, and hence
`BYPASSRLS` on the role being load-bearing rather than incidental.

If the guard ever fires with `0 rows`, check the role's attributes first:

```sql
select rolname, rolbypassrls, rolcanlogin from pg_roles where rolname = 'db_backup';
```

## Restoring

Backups are plain SQL. Prefer the narrowest restore that fixes the problem.

### One user's row (the common case)

Do this instead of a full restore whenever a single account is affected. Pull
the backup, extract that user's blob, and write it back:

```bash
aws s3 cp "s3://$BACKUP_S3_BUCKET/supabase/run-app-<stamp>.tar.gz" .
tar -xzf run-app-<stamp>.tar.gz
grep -A2 "COPY public.app_state" run-app-<stamp>/data.sql | grep "<user-uuid>"
```

The row is a tab-separated `user_id`, `data`, `updated_at`. Apply the `data`
value with a targeted `update public.app_state set data = '<json>'::jsonb
where user_id = '<uuid>'`.

**The user must close the app first.** A running client holds the pre-restore
blob in memory and will overwrite the row on its next write — this happened
during the July 2026 recovery and re-blanked a field that had just been
restored.

### Whole database

Into a fresh project, in this order:

```bash
psql "$TARGET_DB_URL" -f run-app-<stamp>/roles.sql
psql "$TARGET_DB_URL" -f run-app-<stamp>/schema.sql
psql "$TARGET_DB_URL" -f run-app-<stamp>/data.sql
```

Note what these dumps do **not** cover: `auth.users` is managed by the Supabase
platform and is not included, so a restore into a new project leaves rows whose
`user_id` has no matching account. For a full disaster recovery use Supabase's
own project-level backup/PITR, and treat these dumps as the table-level safety
net they are.

## Related

- `src/db.ts` — the single-blob store and the write-gate that keeps a failed
  read from becoming a delete.
- `docs/coach-agent.md` — `agent_rounds.input_context`, an incidental
  (append-only) snapshot of plan + recent runs that made the July 2026
  recovery possible.
