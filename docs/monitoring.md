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
Each sits well above a normal day (baselines from November 2026: ~400
successful API calls, ~70 coach calls from a couple of addresses, 1 signup, 1
password reset, no 5xx, no 429s, no failed sign-ins).

**Failures**

| Signal | Threshold | Why |
| --- | --- | --- |
| Auth 5xx at the gateway (`/auth/v1/recover`, `/signup`, ...) | 1 | Auth mail or sign-in is broken; users are locked out. Watch it after an SMTP key rotation. |
| GoTrue error lines | 1 | GoTrue's access log carries no route, so its own errors are counted separately. |
| Edge function 5xx | 1 | A function is failing for real callers (coach, imports, live sharing). |
| Function lifecycle event other than Boot/Shutdown/Log | 1 | A boot failure or uncaught crash, often a broken deploy. |
| Other gateway 5xx (REST, realtime, storage) | 3 per path | Database or platform trouble; a lone blip is noise. |
| `console.error` in a function | 10 per function | Clients hanging up log a few `connection closed before message completed` a day. |
| Function call of 30 s or more | 3 per function | Drifting toward the wall-clock limit before it starts timing out. |
| Postgres `FATAL`/`PANIC` | 1 | Always worth a look. |
| Postgres `ERROR`, new SQLSTATE | 1 | A kind of error not seen daily: often a grant or RLS mistake after a migration. |
| Postgres `ERROR`, known SQLSTATE | 25 | `42501`, `P0001`, `23505` occur daily (below). |
| Realtime error lines | 3 | Live sharing rides on realtime. |

**Abuse and attacks**

| Signal | Threshold | Why |
| --- | --- | --- |
| Failed `/auth/v1/token` (400) | 20 a day | Password guessing, or a client stuck refreshing a dead session. |
| Addresses with 10+ failed sign-ins | 1 address | Credential stuffing. The summary counts addresses and never names them. |
| Auth admin API writes (`/auth/v1/admin/*`, not GET) | 1 | No edge function calls it, so outside your own dashboard edits this means the service-role key is in someone's hands. |
| Signups, or password-reset requests | 20 a day each | Throwaway accounts multiply coach budgets and catalogue caps; a reset burst can be someone mail-bombing an address. |
| 429 responses | 10 per path | Rate limits being hit: mailer cooldown, coach daily limit, live-watch throttle (share-token guessing). |
| 403/404/405 | 50 per API | Someone probing endpoints or RPCs. 401 is the known signed-out noise. |
| Coach calls | 400 a day | The model bill. |
| Addresses with 150+ coach calls | 1 address | One client scripting the coach. |

**Silence**

| Signal | Threshold | Why |
| --- | --- | --- |
| Successful API responses | fewer than 50 a day | The app may be down before it reaches Supabase (a broken deploy, DNS, a crash on launch), which produces no errors at all. Raise or lower it as real traffic moves. |

**Security advisors**: any WARN/ERROR finding not in `ACCEPTED_LINTS`
(`log-scan.sh`), such as a new lint after a migration. INFO lints are the intended
service-role-only tables.

Known daily noise, below threshold: a device whose session has lapsed keeps
calling `app_state`, `live_runs` and `run_routes` and opening a realtime
subscription. Postgres refuses them (`42501 permission denied`; realtime's
filter check raises `P0001 invalid column for filter user_id`), and the gateway
returns 401. Correct refusals, but the app shouldn't be syncing without a session.

Tune by editing the SQL (a threshold, or a SQLSTATE moved into the known list),
or `ACCEPTED_LINTS` once a finding is reviewed. Output is counts and codes only:
this repo's Actions summaries are public, so never add a column with a message,
an IP, a user id or a name (audit lines carry display names). The query travels
in a GET URL: the script strips comments and whitespace (about 8 KB encoded), so
keep new branches lean.

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
