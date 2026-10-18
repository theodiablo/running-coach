# Product metrics

Maintainer-only numbers about the product: users, activity, runs, plans, coach
use and spend, feedback. Today they arrive as a weekly email; the same endpoint
is ready for a dashboard page.

## Where the numbers come from

`public.admin_metrics()` returns one jsonb of **aggregates only** — no emails,
ids or per-user rows — so nothing it returns is personal data. It is
`security definer` (it counts `auth.users`), executable by `service_role`
alone. Run it in the SQL editor to see the raw shape.

The database is the source of truth, not PostHog: analytics are opt-in, so
event counts undercount, and runs and plans live only in the `app_state` blob.

- **Active** = an `app_state` save in the window. Sessions refresh silently, so
  `auth.users.last_sign_in_at` undercounts badly; don't switch to it.
- **Runs** are windowed by the run's own `date`, not when it was saved, so an
  import of old runs doesn't spike "this week". Distance excludes `OTHER`.
- **Plans** are only the current plan per user. There is no record of each
  generation, so "plans built per week" needs a server-side counter first.
- **Coach spend** is tokens from `agent_rounds` × list price in
  `_shared/adminMetrics.mjs` (`MODEL_PRICES`), ignoring caching. A model not in
  the map is listed as unpriced, never guessed — add it when `COACH_MODEL`
  changes. Anthropic exposes no prepaid-balance endpoint; its Admin API key can
  manage the whole organization, so don't store one here just for a cost figure.
- Your own account is counted like any other.

## The edge function (`admin-metrics`)

`verify_jwt = false` in `supabase/config.toml`, because the digest caller has no
JWT. Both doors are checked in the function; anything else is 403.

1. **Digest** — `POST` with header `x-admin-digest-secret` equal to the
   function secret `ADMIN_DIGEST_SECRET` (constant-time compare; an unset secret
   matches nothing). Emails `formatDigest`'s text to `MAINTAINER_EMAIL` through
   the same SES secrets as `notify-contribution`.
2. **Dashboard** — `GET` with a user access token. Admitted only when the
   verified user is `ADMIN_USER_ID` **and** the token is `aal2` (signed in with
   MFA). Returns the metrics plus `coach.cost` per window.

## Setup

- `supabase secrets set ADMIN_DIGEST_SECRET=$(openssl rand -hex 32)` and the
  same value as the repo secret `ADMIN_DIGEST_SECRET`.
- `.github/workflows/admin-metrics-digest.yml` posts every Monday 06:20 UTC
  (or run it by hand from Actions); it skips itself while the secret is absent
  and fails, so GitHub notifies, on any non-200.
- For the dashboard door only: `supabase secrets set ADMIN_USER_ID=<your
  auth.users id>`, and enrol a TOTP factor on that account (Supabase Auth MFA)
  so it can reach `aal2`. Unset, the door is closed.

## A dashboard page, later

Host it apart from the app bundle (its own subdomain on S3 + CloudFront, via
Terraform), so admin code never ships to every user. It signs in with Supabase
Auth + MFA and calls the dashboard door; no new identity provider is needed
while it only shows aggregates. If it ever shows per-user rows or gains write
actions, isolate it behind its own identity (e.g. a Cognito pool with sign-up
disabled) so a stolen app session can't reach it.
