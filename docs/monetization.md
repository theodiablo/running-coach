# Monetization

Durable product decision for how (and how not) to make money from Running Coach.
Read this before adding a paywall, a pricing section, an entitlement/tier
concept, or any change to the coach rate limit. The load-bearing rules are also
summarized in `CLAUDE.md`; this file holds the reasoning.

## Direction (the decision)

- **The app stays free.** Everything a runner needs to train — plans, GPS
  tracking, the community race catalogue, and the AI coach — is free. The
  marketing promise is deliberately worded "everything you need to train is
  free" (not the absolute "free includes everything") so a future paid tier of
  *new* features never contradicts the page.
- **A paid tier, when it comes, is built from _new_ premium-only value — never
  by taking something away.** Never move an existing free feature behind a
  paywall, and never lower `RATE_LIMIT_PER_DAY` to force upgrades. New headline
  features should land premium-first so nothing is ever clawed back from free
  users.
- **The coach daily limit is cost-insurance, not a monetization lever.** See the
  cost analysis below: real usage is far below even a low cap, so a limit-based
  paywall would convert nobody. `RATE_LIMIT_PER_DAY` exists to bound the blast
  radius of a runaway/abusive user, not to sell upgrades.

## Cost of the free tier

Measured from production `agent_rounds` (2026-07, ~2 weeks of real usage):

- The coach runs on `claude-sonnet-5` (`COACH_MODEL`, `max_tokens: 4096`,
  system prompt cached). Only `propose`/`critique` rounds are charged against
  the daily limit.
- Average charged round: ~13k input + ~1.75k output tokens (p90 ~21k/3.4k).
- Sonnet 5 pricing $3/M in, $15/M out ⇒ **≈ €0.06 per coach query** (a bit less
  during any introductory pricing window).
- Worst case for one user maxing a 20/day limit: ~€36/month. At 5/day: ~€9/month.
- **Actual usage is tiny**: ~25 charged rounds *total across all users* in two
  weeks (≈ €1.6 total). Nobody is near the limit.

Implication: tightening the limit saves almost nothing and sells nothing. The
limit is a safety valve; monetization must come from new value.

## Options considered

- **Freemium subscription (recommended paid path).** A "Supporter" tier of new
  proactive-coach features (see below). Price aligns with cost because these
  features genuinely consume more model tokens. Suggested price ~€4.99/month
  (nets ~€4.24 after the 15% store small-business cut, comfortably covering a
  heavy user), or ~€3.99 as an impulse price; annual ~€34.99–39.99. In-app sales
  must use Play Billing / Apple IAP; web can use Stripe. RevenueCat can unify all
  three behind one entitlement source (its webhook writes a per-user entitlement
  row that `checkRateLimit` reads instead of the global env var).
- **Tip jar (shipped).** Buy Me a Coffee link in the marketing footer
  (`TIP_JAR_URL`, web-only by construction — Apple rejects external payment
  links in the iOS app). Near-zero effort; gauges goodwill; funds the coach's
  API cost. Live today.
- **One-time "lifetime" unlock.** Mismatched with the coach's *recurring* API
  cost; only sensible for non-AI perks. Not the primary model.
- **Ads.** Rejected — clashes with the privacy-first positioning (opt-in
  telemetry, no autocapture), earns cents at this scale, and would be hostile UX
  during a run.
- **Affiliates / partnerships around the race catalogue.** Race-registration
  affiliate links or featured local-race listings monetize the catalogue without
  charging users. A later-stage complement once there's meaningful traffic;
  requires disclosure.
- **B2B / coach marketplace / white-label.** A real business but a large product
  pivot, out of scope for "small income."

## What a paid tier would actually contain

Premium value should be _new_, and the app's own architecture points at the
strongest candidates:

1. **Proactive coach (best fit — cost-aligned).** Today the coach is reactive
   (user opens the chat). Premium flips it proactive, reusing the existing engine
   + validator + safety rules through new entry points:
   - Post-run feedback: a short coach note after each saved run (pace vs plan,
     HR drift, "ease up tomorrow").
   - Weekly review: a scheduled round that reviews the week vs the plan and
     *proposes* next-week adjustments via the existing propose-and-confirm flow.
   - Race strategy: an elevation-aware pacing plan with a coach narrative.
   These consume more model tokens, so price aligns with cost — and they mirror
   what paid running apps charge for.
2. **Deep analytics (zero marginal cost).** Training-load / fitness-fatigue
   trends, HR-drift and zone distribution over time, a race-time predictor, PB
   history — all computable client-side from existing `runs` data. The
   Strava-premium model.
3. **Convenience:** calendar export (.ics), richer multi-race handling. Bundle
   filler, weak on its own.

## Sequence

1. **Now:** tip jar (done) — real money possible today, no vaporware tier.
2. **When ready to charge:** the proactive-coach Supporter tier — entitlements
   table + RevenueCat (Play Billing + StoreKit + Stripe web) + per-user limit in
   `checkRateLimit` + an upsell on the `RATE_LIMIT` error, plus an honest pricing
   section in `src/marketing/marketing.*.json` (keep the free tier's non-numeric
   fair-use phrasing true).
3. **Later, with traffic:** race-registration affiliates/partnerships via the
   catalogue.

At current (beta) scale, growth matters more than conversion — but the
premium-first / never-claw-back rule is decided **now** so nothing has to be
walked back later.

## Shipped: the premium seam (2026-07)

The entitlement mechanism exists, and the **route finder** ("Find a route") is
the first premium-only feature. Consistent with the never-claw-back rule: it
landed premium-first and never shipped free.

**Schema** (`20260724130100_premium_until.sql`) — two nullable columns on
`profiles`, service-role-writable ONLY (no grant statements needed: the
column-scoped `authenticated` grants from `20260719120000` don't extend to new
columns, so this is airtight by construction; table-level `select` + "read own"
RLS still let a user read their own state):

- `premium_until` — NULL = free; a future timestamptz = premium.
- `premium_since` — first-ever grant, never cleared or moved forward. This is
  the loyalty datum ("supporter since …") no later history table could
  backfill, which is why it exists before there's a feature using it.

Deliberately **no history table yet**: cumulative-months and lapse/return
history should be modelled on what the payment provider's webhook actually
sends, and adding a table later is a cheap append-only migration. **The first
automated writer must dual-write an append-only entitlement-events table**, and
from then on manual comps go through the provider's *granted entitlements* so
the webhook stays the single writer to these columns (otherwise an `EXPIRATION`
event silently revokes a hand-granted comp).

**Enforcement** is always server-side, per feature:

- `route-suggest` → `{code:"PREMIUM_REQUIRED"}` before it touches the quota
  table, so free callers never consume one.
- `coach-agent` → premium raises the daily budget to
  `PREMIUM_RATE_LIMIT_PER_DAY` (40, vs the free default of 5). This RAISES the
  paid allowance; the free number never moves. Precedence:
  `profiles.coach_daily_limit` override → premium → env default.

Both read the columns via the service-role client, and a failed read throws to
the generic error path rather than quietly reading as "free" — with one
deliberate exception. **Deployment ordering:** edge functions auto-deploy on
push to main while migrations are applied by hand, so a function can reach
production before its column exists. Both treat PostgREST `42703`
(undefined_column) as "premium is not available here" rather than an error:
coach-agent falls back to the free budget (a throw would surface as
COACH_UNAVAILABLE for *every* user, premium or not) and route-suggest answers
PREMIUM_REQUIRED, keeping the gated feature shut. Apply the migration BEFORE
merging anything that ships these functions.

**Client** (`src/premium.ts`) is UI only. A failed/offline read means free, so
the teaser refetches when it opens. `'infinity'` is banned as a value: PostgREST
serialises it as a literal string that `Date.parse` turns into NaN, which would
demote a lifetime supporter to free at both ends. Use a concrete far-future date.

**Granting premium** (dashboard SQL editor, which runs as service role):

```sql
update public.profiles
   set premium_until = now() + interval '1 year',
       premium_since = coalesce(premium_since, now())
 where email = 'someone@example.com';
```

The same statement from the app (anon/authenticated) fails on column
privileges — a useful self-test of the seam. There is **no purchase flow yet**,
so this is the only way in; consider granting it to existing tip-jar supporters
and beta testers so the feature has real users and the lock isn't purely
theoretical. Lapse is silent (no cron, no notice): acceptable while the gated
feature is ephemeral route suggestions and grants are manual.

**Free-user UX:** locked entry point + `PremiumTeaserSheet` on web/Android;
**hidden entirely on iOS** (`canShowPremiumTeaser`) while no IAP exists — a
permanently locked "coming soon" affordance is placeholder UI under App Store
guideline 2.1, and payment-adjacent copy next to the external tip jar invites a
3.1.1 steering question. Teaser copy therefore names no price, no payment, and
no "supporters", and never asserts the viewer's own tier (an offline premium
user can land there). If no purchase path exists within ~2 quarters, demote the
teaser to hidden rather than let "coming soon" rot.

## Payments path (researched 2026-07)

Rates verified July 2026; re-check before building, these move.

| Route | Fees on a €4.99/mo sub | Notes |
|---|---|---|
| **IAP + RevenueCat** | ~15% | RevenueCat free below $2,500 MTR, then 1%. Stores are merchant of record → **zero VAT admin**. |
| Direct store IAP | ~15% | Same fees, but you own two receipt-validation paths + ASSN/RTDN webhooks. |
| Stripe web checkout | ~8-9% | Cheapest, but **you** become merchant of record → VAT/OSS registration and filings. |
| Merchant-of-record (Paddle etc.) | ~15% effective | 5% + $0.50 — the fixed fee eats a €4.99 ticket. Only sensible on an annual plan. |

**Recommendation: native IAP on both stores unified by RevenueCat.** It is free
at this scale, collapses the plumbing to one webhook writing `premium_until`
(plus the events table above), supports granted entitlements for comps, and the
stores handle all tax. Requires enrolling in Apple's **Small Business Program**
(15% instead of 30%). Google Play subscriptions are 15% with Play Billing,
dropping to ~10% via external/alternative billing in covered regions since June
2026.

Add **Stripe web checkout** later as a secondary channel, not a replacement:
outside the US storefront, guideline 3.1.3(b) requires a subscription unlocked
in the iOS app to *also* be available as IAP, so web-only is not App-Store-safe.
US iOS external links are currently 0% commission pending the Supreme Court
ruling (~2027) — treat that as temporary. EU DMA terms land around 7-15% all-in,
so they beat nothing at this scale.

When purchases ship, the privacy policy needs a payments-processor entry.
