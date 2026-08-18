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
strongest candidates. (The reasoning is here; the concrete, status-tracked list
is "Planned premium lineup" below.)

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
   Strava-premium model. **Note the split decided in 2026-07** (see the
   best-efforts entry below): the zero-cost *moment* can be free while the
   *analysis* stays premium. Cost can't justify a gate here, so the line is
   drawn on product value, not compute.
3. **Convenience:** calendar export (.ics), richer multi-race handling. Bundle
   filler, weak on its own.

## Sequence

1. **Now:** tip jar (done) — real money possible today, no vaporware tier.
2. **Now:** the entitlement seam exists and premium features are being built
   behind it, **invisible to free users** — see "Planned premium lineup" below.
   No tier is announced, so there is nothing to be impatient about.
3. **When the lineup is worth paying for:** unveil the Supporter tier in one go
   — flip `canShowPremiumTeaser`, add RevenueCat (Play Billing + StoreKit +
   Stripe web) writing `premium_until` + the entitlement-events table, an upsell
   on the `RATE_LIMIT` error, and an honest pricing section in
   `src/marketing/marketing.*.json` (keep the free tier's non-numeric fair-use
   phrasing true).
4. **Later, with traffic:** race-registration affiliates/partnerships via the
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
 where id = (select id from auth.users where email = 'someone@example.com');
```

The same statement from the app (anon/authenticated) fails on column
privileges — a useful self-test of the seam. There is **no purchase flow yet**,
so this is the only way in; consider granting it to existing tip-jar supporters
and beta testers so the feature has real users and the lock isn't purely
theoretical. Lapse is silent (no cron, no notice): acceptable while the gated
feature is ephemeral route suggestions and grants are manual.

**Free-user UX: nothing at all, on every platform.** `canShowPremiumTeaser` is
`false`, so a free user sees no premium entry point anywhere — for the route
finder that means both the tracker button and the plan session's "Find a route"
menu item are simply absent. This is the "demote the teaser to hidden rather
than let 'coming soon' rot" call, taken early and deliberately: with no purchase
flow, a locked affordance is a dead end that advertises a feature the user can
do nothing about. Premium users (granted by hand) see the real feature normally.

The locked-affordance + `PremiumTeaserSheet` treatment stays wired behind that
one flag, so the tier unveils by flipping it. Two rules for whoever does:

- **Gate premium affordances on `isPremium || canShowPremiumTeaser`, never on
  `isPremium` alone** — that is what makes the whole tier reveal at once.
- **Flip it back to `!isIos`, not `true`,** unless StoreKit purchases ship at
  the same time: a permanently locked "coming soon" affordance is placeholder UI
  under App Store guideline 2.1, and payment-adjacent copy next to the external
  tip jar invites a 3.1.1 steering question. Teaser copy therefore names no
  price, no payment and no "supporters", and never asserts the viewer's own tier
  (an offline premium user can land there).

Known consequence: a premium user whose entitlement read failed at sign-in (say,
launched offline) now has no affordance to tap, and tapping was what triggered
the re-read. They recover on the next sign-in or app restart. Acceptable while
grants are manual and few; if the re-read ever becomes the only recovery path,
give `App.tsx` a retry instead of bringing the locked button back.

## Planned premium lineup (unveil together)

The tier stays hidden until it is worth paying for. One locked feature is not a
product; a handful, revealed at once alongside a purchase flow, is. This is the
running list — status is honest, so a feature only moves to **built** when it
actually ships behind the flag.

Sequenced by the same logic as the options above: cost-aligned features first
(they justify the price), zero-marginal-cost analytics as the volume filler,
convenience last.

| # | Feature | Why premium | Status |
|---|---|---|---|
| 1 | **Route finder** — loop suggestions from your location and a target distance (`docs/route-finder.md`) | Real per-call upstream cost (ORS), landed premium-first so nothing is clawed back | **Built**, hidden behind `canShowPremiumTeaser` |
| 2 | **Post-run coach note** — a short automatic read on each saved run (pace vs plan, HR drift, what to do tomorrow) | Turns the coach from reactive to proactive; one model round per run, the clearest cost-aligned value | Planned |
| 3 | **Weekly review** — a scheduled round that reviews the week against the plan and *proposes* next-week adjustments through the existing propose-and-confirm flow | Recurring model spend; the headline "having a coach" moment | Planned |
| 4 | **Race strategy** — elevation-aware pacing plan plus a coach narrative for a target race | High-value, race-shaped, model-heavy | Planned |
| 5 | **Deep analytics** — training load / fitness-fatigue trend, HR-drift and zone distribution over time, race-time predictor, **PB progression / best-effort history** | Zero marginal cost, all computable client-side from existing `runs`; the Strava-premium model | Planned — the *data* shipped free (see below), the *history surface* is the premium half |
| 6 | **Convenience** — calendar export (.ics), richer multi-race handling | Bundle filler, weak on its own | Planned |
| 7 | **Higher coach daily budget** (`PREMIUM_RATE_LIMIT_PER_DAY`, 40 vs 5) | Already shipped as a *raise*; never framed as the reason to buy | **Built** |
| 8 | **Guided workouts** — live step-by-step tempo/interval/run-walk guidance in the tracker with voice/beep cues, screen-off included (`docs/guided-workouts.md`) | The "workout mode" running watches charge for; new value (structured sessions were never guided), landed premium-first | **Built**, hidden behind `canShowPremiumTeaser` |

### Live run sharing: shipped free (2026-08)

Built same-account v1 and the public `/watch/:token` link on top of it, both
originally behind `canShowPremiumTeaser` as row 6b of the lineup above. The
premium gate was removed entirely: the toggle, the watcher subscription, and
the `live_runs` insert policy are now free for every signed-in account (see
`docs/live-sharing.md`). Per **Never claw back**, it does not return to this
list.

### Best efforts: the moment is free, the history is premium (2026-07)

The first feature where the free/premium line had to be drawn *inside* one idea,
and the precedent for the rest of #5. Full detail: `docs/best-efforts.md`.

**Shipped free:** best-effort extraction (fastest 1K/5K/10K/half/marathon per
run), PB ranking against the log, the post-run reward sheet, and the best-efforts
card in run detail.

**Why free, when it was floated as premium.** The cost analysis that gates every
other decision here says nothing: efforts are extracted once at save time from a
trace the app already holds, so ranking a run is an in-memory scan of `runs` —
no model call, no edge function, not even a network request. With no cost to
recover, a gate would have to be justified on product value alone, and at this
stage the "you just PB'd" moment is worth more as a retention hook than as a
conversion one. It is also the moment that makes finishing a run *in this app*
worthwhile rather than in Strava.

**A Strava-style time window was considered and rejected** ("last 30/60 days free,
full history premium"). It is the most gating machinery for the least clarity, it
is hard to word without contradicting "everything you need to train is free", and
it is precisely the move that earned Strava a backlash.

**Still premium, and unchanged in the lineup:** the PB *progression* surface —
per-distance best-effort history over time, trends, and the race-time predictor
re-anchored on true best efforts rather than whole-run pace. That's analysis, it
belongs in Progress → Stats with the rest of #5, and it is new value rather than
anything clawed back. The stored `bestEfforts` field is exactly the substrate it
will read; nothing extra needs building on the data side.

One thing that premium surface will want: the free backfill deliberately caps at
the newest 40 GPS runs to keep cold start cheap. A full-history PB view should do
its own deeper, user-initiated pass rather than widening the free boot path.

Rules this list must keep obeying:

- **Never claw back.** Everything above is new value or a raise. Nothing that is
  free today appears here, and the free coach limit never moves down (#7 raises
  the paid allowance only).
- **The free tier stays complete.** Plans, GPS tracking, the race catalogue and
  the AI coach are the product; premium is the layer on top. The marketing
  promise ("everything you need to train is free") must stay literally true
  after the unveil.
- **Unveil = lineup + purchase flow + pricing copy, in one go.** Flipping
  `canShowPremiumTeaser` before there is something to buy just restores the dead
  end this section replaced.

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
