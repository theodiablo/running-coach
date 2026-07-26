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
2. Refuses to upload a dump that is empty, has no `CREATE TABLE`, or contains
   no `COPY public.app_state` rows. A backup that silently contains nothing
   reads as success forever, which is worse than a loud failure.
3. Uploads one tarball to
   `s3://$BACKUP_S3_BUCKET/supabase/run-app-<UTC stamp>.tar.gz` with SSE, then
   re-reads its size to confirm the object is not truncated.
4. Deletes backups older than 30 days (`RETENTION_DAYS`), **always keeping the
   7 most recent** (`MIN_KEEP`) whatever their age, and only ever touching keys
   matching its own `run-app-<stamp>.tar.gz` pattern under its own prefix.

Both retention knobs are `env:` at the top of the workflow.

## Setup

The job skips itself with a warning until these exist.

| Secret | What |
| --- | --- |
| `SUPABASE_DB_URL` | Dashboard → Connect → **Session pooler** → URI, password substituted and percent-encoded |
| `BACKUP_S3_BUCKET` | A **private** bucket, separate from `S3_BUCKET_NAME` |
| `AWS_BACKUP_ROLE_ARN` | Optional; falls back to `AWS_DEPLOY_ROLE_ARN` |

Use the **pooler** host, not `db.<ref>.supabase.co` — direct database hostnames
are IPv6-only and GitHub runners are IPv4-only.

Do **not** reuse `S3_BUCKET_NAME`: that bucket is the CloudFront origin for the
site and is world-readable. These dumps contain personal health data (runs,
heart rate, notes), so the backup bucket needs Block Public Access on. A
dedicated `AWS_BACKUP_ROLE_ARN` is preferred over the deploy role so that write
access to backups stays out of the site-deploy path. The role needs
`s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on
`arn:aws:s3:::<bucket>/*` plus `s3:ListBucket` on the bucket itself.

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
