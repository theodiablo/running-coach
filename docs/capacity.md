# Capacity & rate limits

What caps the app's throughput, and where each cap is set. Hosted-project
settings live in dashboards, not in code, so **this file is the record**:
change one there, update it here in the same breath.

## Recorded production limits (as of 2026-11-01)

### Amazon SES (`eu-west-1`, auth mail via `mail.camboulive.solutions`)
- Sending quota: **50,000 emails / 24h** (out of the sandbox).

### Supabase Auth: Dashboard → Authentication → Rate Limits (`run-app`)
| Limit | Value | Scope |
|---|---|---|
| Emails sent | **600 / hour** | project-wide |
| SMS sent | 30 / hour | project-wide (SMS unused) |
| Token refreshes | 150 / 5 min (1,800/h) | per IP |
| Token verifications (OTP / magic link) | 30 / 5 min (360/h) | per IP |
| Anonymous sign-ins | 30 / hour | per IP (unused) |
| Sign-ups + sign-ins | 30 / 5 min (360/h) | per IP |
| Web3 sign-ins | 30 / 5 min | per IP (unused) |
| Minimum interval per user (custom SMTP) | 30 s | per user |
| IP address forwarding | off | |

`[auth.rate_limit]` in `supabase/config.toml` drives the **local stack only**;
it does not reflect or change these values.

**Effective email ceiling is Supabase's 600/h, not SES** (50k/24h ≈ 2,080/h).
Every signup confirmation, password reset and email change counts against it
project-wide, so a launch spike of >600 signups in an hour starts returning 429
(rendered as the amber cooldown by `authErrorMessage`). Raise it toward the SES
rate before a planned push.

**Per-IP limits bite on shared networks**: a race-day venue Wi-Fi or a mobile
carrier's NAT puts many runners behind one IP, and 30 sign-ins per 5 minutes is
shared between all of them.

## App-level budgets (edge functions, env-tunable)
| Function | Limit | Env var | Scope |
|---|---|---|---|
| `coach-agent` | 5 / day free, 15 new users, 40 premium; `profiles.coach_daily_limit` overrides | `RATE_LIMIT_PER_DAY`, `NEW_USER_RATE_LIMIT_PER_DAY`, `PREMIUM_RATE_LIMIT_PER_DAY` | per user, atomic DB counter |
| `route-suggest` | 30 / day, premium only | `ROUTE_SUGGEST_LIMIT_PER_DAY` | per user, atomic DB counter |
| `suunto-import` | 300 FIT files / day | `SUUNTO_FIT_DAILY_LIMIT` | per user |
| `coros-import` | 300 files / day | `COROS_FILE_DAILY_LIMIT` | per user |
| `live-watch` | 60 runs read / min (a batch spends one per token) | `LIVE_WATCH_RATE_MAX` | per IP, **per isolate** (in memory) |
| `live-publish` | 20 / min | `LIVE_PUBLISH_RATE_MAX` | per IP, **per isolate** |

None of these is a global cap: total coach spend grows linearly with active
users, and total ORS usage with active premium users. The live-sharing limiters are best-effort; they
reset when an isolate recycles and don't add up across concurrent isolates.

## Shared third-party quotas
- **Anthropic API** (coach): org-level rate limits and spend.
- **OpenRouteService** (route finder): one key, one quota for every user.
- **Polar / Suunto / COROS**: per-app API limits.
- **PostHog**: plan event cap (opt-in consent keeps volume low).

## Database
Small compute tier (`max_connections` 60). Client and edge functions reach
Postgres through PostgREST's pool, so connections aren't a per-user ceiling.
RLS policies call `(select auth.uid())`, never a bare `auth.uid()`, so it is
evaluated once per statement (advisor lint 0003); keep new policies that way.
