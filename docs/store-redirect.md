# Store redirect (flyer QR code)

One printed URL, `https://run.camboulive.solutions/get?src=<flyer>`, that sends
each phone to where it can install the app and counts the scan.

## Path

CloudFront behavior `/get` (`infra/site.tf`) → origin
`<ref>.supabase.co/functions/v1` → edge function `get`
(`supabase/functions/get/`, pure half in `_shared/storeRedirect.mjs`), which
answers a `302`:

| User-Agent | Target |
| --- | --- |
| Android | Play listing, `&referrer=utm_source=<src>&utm_medium=qr` (Play Console → acquisition by campaign) |
| iPhone / iPod / old iPad | TestFlight today; the App Store listing once it exists |
| anything else | the web app, `?utm_source=<src>&utm_medium=qr` |

iPadOS 13+ Safari reports itself as a Mac, so iPads land on the web page, which
carries the store buttons anyway.

**The URL is printed, so it is permanent.** It stays on our own domain so the
backend behind it can change; never print a `supabase.co` address. The behavior
is uncached (`CachingDisabled`) because the answer depends on the User-Agent,
and the response is `no-store` for the same reason.

## Counting

Each counted scan is one `qr_scans` row: `created_at`, `platform`
(`ios`/`android`/`other`), `src` (lower-cased slug, max 40 chars, `none` when
absent). **No IP and no User-Agent are stored in `qr_scans`**, so nothing we
keep is personal data and no consent is involved (Supabase's own function logs
still see the request for their retention window). The `/get` behavior runs the
`watch-page` CloudFront Function to drop cookies before the origin request:
the domain's PostHog cookie carries the user id, and a custom origin request
policy would be a resource the CI apply role can't create.

`HEAD` requests, empty agents and known link-preview bots are redirected but not counted. The redirect never waits on
the insert (`EdgeRuntime.waitUntil`), and a failed one only logs. Counts are
approximate and can be inflated on purpose (no rate limit), which is why the
digest's per-flyer line shows only the top 20 `src` values. The table is
service-role only (RLS on, no policies).

The numbers arrive in the weekly digest (`admin_metrics()` → `qr`; see
`docs/product-metrics.md`): this week by platform, all time by platform, all
time by `src`. For the funnel past the redirect, read installs per campaign in
Play Console and, once on the App Store, App Store Connect.

## Switching iOS to the App Store

Set `IOS_URL` in `_shared/storeRedirect.mjs` to the listing (and `APP_STORE_URL`
in `src/constants.ts`; a test pins the two together) and, for campaign
attribution, `APP_STORE_PROVIDER_TOKEN` (App Store Connect → App Analytics →
Campaigns). Redeploying the function is enough; nothing printed changes.

## Making a flyer code

Use a distinct `src` per flyer or venue (`?src=gym-oct26`) and generate the QR
code from the full URL. Scan it with both platforms before printing.
