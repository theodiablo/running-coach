# Monitoring: the daily Supabase log scan

`.github/workflows/log-scan.yml` runs `scripts/log-scan.sh` every morning. It
queries the last 24 hours of Supabase logs and the security advisors, and stays
**silent on a quiet day**: it fails (so GitHub emails you) only when something
crosses a threshold. No AI runs unless it alerts; then ask Claude to investigate
that run, with the Supabase connector.

Daily is the floor, not a preference: the logs endpoint reaches back at most 24
hours, and on the free plan that is all Supabase keeps.

## What it alerts on

All thresholds live in `scripts/log-scan.sql`, which returns only anomaly rows.

| Signal | Threshold | Why |
| --- | --- | --- |
| GoTrue 5xx (`/recover`, `/signup`, `/otp`, ...) | 1 | Auth mail or sign-in is broken; users are locked out. Watch it after an SMTP key rotation. |
| Edge function 5xx | 1 | A function is failing for real callers (coach, imports, live sharing). |
| Gateway 5xx (REST, realtime, storage) | 3 per path | Database or platform trouble; a lone blip is noise. |
| `console.error` in a function | 10 per function | Clients hanging up log a few `connection closed before message completed` a day. |
| Postgres `FATAL`/`PANIC` | 1 | Always worth a look. |
| Postgres `ERROR`, new SQLSTATE | 1 | A kind of error not seen daily: often a grant or RLS mistake after a migration. |
| Postgres `ERROR`, known SQLSTATE | 25 | `42501`, `P0001`, `23505` occur daily (below). |
| Security advisor WARN/ERROR | any not in `ACCEPTED_LINTS` (`log-scan.sh`) | A new lint after a migration. INFO lints are the intended service-role-only tables. |

Known daily noise, below threshold: a device whose session has lapsed keeps
calling `app_state`, `live_runs` and `run_routes` and opening a realtime
subscription. Postgres refuses them (`42501 permission denied`; realtime's
filter check raises `P0001 invalid column for filter user_id`), and the gateway
returns 401. Correct refusals, but the app shouldn't be syncing without a session.

Tune by editing the SQL (a threshold, or a SQLSTATE moved into the known list),
or `ACCEPTED_LINTS` once a finding is reviewed. Output is counts and codes only:
this repo's Actions summaries are public, so never add a column with a message,
an IP or a user id.

## Setup

1. **Scoped token.** Supabase → Account → Access tokens → new **scoped** token:
   this project only, permissions **Logs: Read** and **Advisors: Read**, nothing
   else, with an expiry. A classic token reaches every project and every
   setting on the account; never use one here. When it expires the scan fails
   with "Log query failed", which is the reminder to rotate it.
2. **Environment.** GitHub → Settings → Environments → `monitoring`, Deployment
   branches → Selected → `main` (the same rule as `production`, `backup` and
   `terraform-apply`). Add the token as the environment secret
   `SUPABASE_LOGS_TOKEN`. The job reads `SUPABASE_PROJECT_REF`, an existing repo
   variable.
3. Run it once with **Run workflow** to confirm it passes.

Until the secret exists the job skips with a warning instead of failing.

## When it fails

The job summary lists what crossed which threshold. For the detail behind a
row, ask Claude to investigate that run: the Supabase connector's
`query_logs` reads the same stream with full messages, which stay out of the
public summary. Locally: `SUPABASE_LOGS_TOKEN=... SUPABASE_PROJECT_REF=...
bash scripts/log-scan.sh`.
