# Post-run share card (design)

Status: **design, awaiting approval**. Nothing below is built yet. The product
decisions are in `docs/social.md` ("Post-run share card"), the visual design in
the maintainer's canvas (https://claude.ai/artifact/TJeaNbU8BedgAJN5o6hTG4:
`Main` = A, `Card-Number` = B, `Card-Plan` = D, `Flow-Finish`,
`Flow-Composer`). This file is the technical design. Once the work ships it
becomes the reference doc and this status line goes.

## What the runner gets

A **Share this run** action on the finish screen (`RunCelebration`) and in the
run detail (`RunDetailModal`). It opens a **share builder**: a live preview of
the card, three style chips, a few switches, and one **Share image** button that
hands a 1080×1920 PNG to the OS share sheet (or downloads it on a desktop browser
that can't share files).

| Style | Chip | Shows |
| --- | --- | --- |
| A "Route line" | Route | The route as our own vector line (no map tiles), a headline, distance · time · pace, an optional best-effort pill |
| B "Big number" | Number | One headline figure (a new best, else the distance, else the time), one line of context, distance · time · pace |
| D "Training week" | Week | The race (or block), days to go, week n of m, this week's sessions, today's run |

Dropped from the canvas: the Photo (C) chip and the Image/Link switch. Image only.

## Code layout

All new code sits in one lazy chunk, loaded when the builder first opens, so
the canvas drawing code and the fonts never weigh on app start.

- `src/share/cardModel.ts`: **pure**. Builds the data each style draws
  (`routeCardModel`, `numberCardModel`, `weekCardModel`) and decides which
  styles are offered and which is pre-selected (`cardStyles`, below). No DOM.
- `src/share/routeShape.ts`: **pure**. Trims, projects, simplifies and fits a
  trace into the card's route box.
- `src/share/drawCard.ts`: draws a model onto a `CanvasRenderingContext2D`.
  One function per style plus small helpers (`wrapText`, `roundRect`, `pill`).
  The only code that touches the canvas API.
- `src/share/shareImage.ts`: the share seam (web vs native, below).
- `src/modals/ShareCardSheet.tsx`: the builder. Registers `useDismissable`.
- `src/i18n/locales/{en,fr,es}/shareCard.json`: all copy.

## Rendering: Canvas 2D

**Recommendation: draw with Canvas 2D, and use the same drawing for the preview
and the export.**

SVG → PNG was the alternative (build an SVG string, load it into an `<img>`,
draw that into a canvas, `toBlob`). It looks simpler but breaks where it
matters here:

- An SVG loaded as an image is sandboxed: it can't use the page's fonts, so
  every font would have to be inlined as a base64 `@font-face` in each SVG
  (~100 KB per render), and Safari has a long history of drawing the first frame
  before an inlined font has decoded.
- Text in SVG doesn't wrap, so line breaking for long race names or French and
  Spanish copy is manual either way.
- `foreignObject` (HTML inside SVG, the only way to reuse our markup) taints the
  canvas on WebKit, so `toBlob` throws: no export at all.

Canvas 2D has none of these problems. We measure and wrap text ourselves
(`wrapText`, with a word-split fallback and an ellipsis after a max line count).
Fonts come from the page once loaded. The output is the same pixels on every
platform.

**One drawing, two sizes.** The canvas design is 360×640 CSS px. `drawCard`
always draws in that coordinate space after `ctx.scale(k, k)`:

- export: k = 3 → **1080×1920** (the 9:16 story size Instagram and WhatsApp
  expect; 8.3 MB of pixels, fine on every supported phone).
- preview: k = displayed width / 360 × `devicePixelRatio`, so it is sharp on
  retina screens and the preview is the export, scaled down.

The canvas is created with `document.createElement("canvas")`, never
`OffscreenCanvas`, which iOS only has from 16.4.

**iOS 15.4 floor** (CLAUDE.md, "iOS 15.4 is the deployment floor"). The canvas
features we use must exist in a Safari 15 engine:

- `ctx.roundRect` is iOS 16+ → our own `roundRect` path helper (`arcTo`).
- `ctx.letterSpacing` is iOS 18+ → not used. The −0.03em tracking on B's big
  number is dropped, or emulated by drawing glyphs one at a time if the
  difference shows.
- `canvas.toBlob`, `FontFace`, `document.fonts.load` and `Path2D` are all fine.
- No regex lookbehind in the new code (linted) or anything it pulls in (the
  bundle scan still runs in `npm run build`).
- `build.target` is unchanged.

**Fonts.** The app UI uses the system font, which is no good for an exported
image: it differs per platform, and canvas can't reliably name it. The cards use
the canvas's two families:

- **Archivo** (`@fontsource/archivo`, already a dependency, today only in the
  web marketing chunk) for the figures and headlines: weights 800 and 900.
- **Inter** (`@fontsource/inter`, **a new dependency** in PR 1) for labels and
  body text: weights 400, 500, 600 and 700.
- Both use the `latin` + `latin-ext` subsets (accents and race names like
  "Łódź"), imported as `?url` woff2 assets in the share chunk only. That is
  about 12 files, ~25 KB each, loaded on first open.
- They ship inside the APK/IPA because they're local assets: no Google Fonts
  and no CSP change.
- The builder loads them with `new FontFace(...)` + `document.fonts.add` and
  awaits `document.fonts.load` for each family and weight **before the first
  draw**. A canvas drawn before the font is ready falls back silently and never
  redraws.

**Colours** come from the canvas design (slate `#0b1220` ground, orange
`#f97316` accent, B on an orange ground). They live as constants in
`drawCard.ts`. A card is an image, not a themed surface, so light mode doesn't
change it.

**Brand mark**: the same polyline-and-dot mark as the header, drawn as a path.

**Privacy of the file**: a canvas PNG has no EXIF and no location. The card
shows the **date only** (decided): the canvas's start time ("8:14") is left
out, because a time of day on a public story tells strangers the runner's
routine.

## Pre-selection: one pure helper

```ts
type CardStyle = "route" | "number" | "week";
cardStyles(input): { offered: CardStyle[]; preselected: CardStyle }
```

Input: whether the run is a personal best, whether it has a usable trace,
whether a plan session goes with it, and the plan phase.

Rules, in order (the decided rule, plus the fallbacks the decision didn't
cover):

1. **A personal best → B.** A measured effort that is a personal best
   (`isPersonalBest`) twice over:
   - in `rankRunEfforts(run, runs, { measuredOnly: true })`, where estimates
     are dropped on both sides, so this run's measured time is ranked against
     other runs' measured times only;
   - and in the plain ranking, so a faster hand-logged effort in the log still
     rules out "best".

   The gain shown is against the last measured best. A first effort
   (`isFirstEffort`, under the same two conditions) is not a best and doesn't
   count. B can then say "First 10K", never "best".
   - Unlike the finish screen's trophy, an estimated effort (a manual run's
     time scaled from its average pace) is never claimed, nor beaten. The
     finish screen is private. A card is a public claim, and an estimate is
     not a time the runner ran.
2. **A run that settled a plan session → D**, when D is offered. In the run
   detail, "settled" is a plan session with `runId === run.id` (the link
   `linkSess` writes). On the finish screen the run isn't saved or linked yet,
   so the signal is the session the recorder was opened from (`session`
   prop). That is the same session `celebrate()` already reads, and the one the
   save screen will propose.
3. **A usable trace → A.**
4. **Otherwise → B** (a manual entry, an import with no GPS, an indoor session).

**Which styles are offered:**

- **A** only with a trace that survives the start/finish mask (at least ~200 m
  of line left; no point count, since a simplified straight street is two
  points). A run with no trace (manual, indoor, HR-only import, a trace that
  failed to load) offers no Route chip. We don't draw a card with a hole.
- **B** always.
- **D** only when there is a plan, `planPhase` is `active`, `raceWeek` or
  `open`, **and the run's date falls in the plan's current week** (today's
  Monday–Sunday).
  - In `debrief`, `choosing` or `recovery` there is no "week n of m" to stand
    on, and a card saying "−3 days to go" would be wrong.
  - A run from an earlier week is not offered D: the card would combine this
    week's sessions and countdown with an old run.
  - So a run that settled a session in a post-race recovery week, or one
    opened from History weeks later, pre-selects A or B.
  - Drawing D for the run's own past week (its countdown as it was then) was
    the alternative. It was left out: the card would read as current on a
    story posted today.

The runner can always switch between the offered chips. Tests cover each rule
and each fallback.

## What each style reads

Every figure goes through the existing helpers: `fmt.dur`, `fmt.pace`,
`fmt.date` (locale-aware). No new formatting.

**All styles**

- Distance `run.km`, time `run.durationSec`, pace `durationSec / km`. These are
  the same figures the run detail tiles show.
- **Cross-training and indoor runs (`km: 0`, `isCrossTraining`)**: no
  distance, no pace and no route, because a bike's km isn't a running km
  (CLAUDE.md). Those cards show the time, the activity name, and average HR
  when present. The Show pace switch is hidden.
- Footer: "Tracked with Running Coach". The canvas's "free on iPhone and
  Android" is a claim that's only true once `APP_STORE_URL` is set (iOS is still
  TestFlight, `docs/marketing.md`). So the platforms line is derived from that
  constant, not written into the copy.

**A: Route line**

- The trace: on the finish screen, the recorder's in-memory simplified
  points, `tracePausesRemoved` as `celebrate()` receives them. In the run
  detail, the route `useRouteTrace` already fetched, passed to the builder as a
  prop, so it isn't fetched twice. A `routeTmp` run (trace not uploaded yet) uses
  the pending copy the same way the detail map does.
- Headline: a short pool of the card's own (`shareCard.head.run`, and
  `shareCard.head.pb` for a measured best), picked by run id so reopening the
  builder doesn't reshuffle it. Both entry points use the same pool.
  - The celebration's pools speak to the runner ("You earned this one"). On
    the runner's own story those lines read as if someone else wrote them, so
    the card's lines are neutral or in the runner's voice.
- Best-effort pill: the longest measured `isPersonalBest` effort; nothing
  otherwise. A whole-run estimate (`EffortRank.estimated`) never earns the
  pill: no claim beyond the log.

**B: Big number** (the headline figure, in order)

1. a personal best: the best effort's distance label + time ("10K / 49:51"),
   and one line of context. The context line only compares with the previous
   best when the log has one ("38 seconds quicker than your last best");
2. a first effort: "First 10K" + time;

   Both only for **measured** efforts (see the pre-selection rule).

3. a run with distance: the distance ("10.4 km");
4. an indoor session: the time.

The bottom row repeats distance · time · pace (indoor: time · avg HR).

**D: Training week**

- `planPhase(...)` for where the runner stands, `mainRace(plan, settings)` for
  the race. The race's display name is the logic Home already uses (catalogue
  label, participation label, else "your race"). PR 1 moves that out of
  `Dashboard.tsx` into a shared helper rather than copying it.
- Days to go: from `race.date` (`daysSince` negated). "Race day" on the day.
- Week n of m: the current week's `weekNumber` out of the race week's.
  Recovery weeks after the race aren't counted. Elapsed `past-` weeks are
  already numbered continuously by `carryProgress`, so they're counted as-is.
- Phase label: the plan week's `phase`, through the same i18n keys Plan uses
  (sentence case, plain words).
- This week, Mon–Sun: per day, done (a session with `done`), today, still
  open (a planned session not yet done), or rest. **Still-open days are a
  neutral ring**, never a red mark or a cross: the anti-streak stance
  (`badges.ts`, `overdueSessions` copy) applies to an image as much as to a
  screen. "3 of 4 runs done · 26.1 km so far" counts sessions with `done`, and
  km from this week's runs excluding cross-training.
- The run's row: the settled session's type name (`common.types`, plain
  word first) and this run's distance · time · pace.
  - **A run with no linked session** (a manual entry or recording not tied to
    the plan, still in the current week) uses the run's own type
    (`run.type`, through the same `common.types` keys). On the finish screen
    the run isn't typed yet, so the row just reads "Today's run". The day's
    planned session, if any, is not claimed as done: its dot in the Mon–Sun
    row keeps its own state. D is still offered (the plan context is real),
    but never pre-selected for such a run (pre-selection rule 2 needs a
    settled session).
  - Labelled "Today" only when the run's date is today.
  - Otherwise labelled with its weekday ("Saturday: long run"). The run is in
    the current week (see "Which styles are offered") but may be from an
    earlier day of it.
  - Its day in the Mon–Sun row is the one highlighted, not today's.
- **Open/block plans** (`phase: "open"`): no race and no countdown. The header
  becomes "Training block 2 · week 3 of 4" (`block`, the block's weeks) and the
  bar spans the block.
- Plans and dates in tests: pinned clock and derived dates, `describe.each`
  over both anchors (CLAUDE.md, "A test that builds a plan…").

## Route: simplification and hiding start and finish (`routeShape.ts`)

1. **Start from the stored points** (`[lat, lng, t, alt]` tuples, `null` =
   gap). Gap markers stay as breaks: each segment is drawn as its own path,
   never bridged with a straight line across a gap on the card. The start and
   finish are the first and last non-null points.
2. **Simplify in lat/lng** with the existing `simplify` (Douglas–Peucker). It
   takes those tuples, gaps included, and measures its epsilon in metres
   internally (`perpM`). The epsilon is the trace's bounding-box diagonal in
   metres / 500, so a marathon and a 3 km loop both land around a few hundred
   points: smooth at 1080 px, cheap to draw. It happens **before** the mask, so
   simplification can never draw a new shortcut through a hidden area.
3. **Project** the simplified points to local metres (equirectangular around
   the trace's mean latitude, the same projection `perpM` uses). That is
   exact enough at run scale, keeps the shape's aspect ratio, and doesn't need
   a map library. Everything after this step is in metres, then card pixels.
   Longitudes are first **unwrapped** across ±180° (each shifted by 360° to stay
   within 180° of the one before), so the bounding box, the simplifier, the
   projection and the mask all see a route crossing the antimeridian as one
   piece.
4. **Hide around start and finish**, **always**, with no switch: a **radius mask**,
   not an end trim. Nothing is drawn within 300 m of the start point *or* the
   finish point, **wherever it falls in the run**.
   - It works on **legs, not points**. Each leg (two consecutive points) is
     clipped against both circles. Line-circle intersection in the projected
     metres gives 0, 1 or 2 crossing points, and only the parts outside the
     circles are kept. A leg that cuts through a circle with both ends outside
     it (sparse GPS, or a long simplified leg) is split, and its middle is
     dropped. Dropping only the points inside the circle would leave that leg
     drawn straight through the hidden area.
   - Where a leg is cut, the line breaks, as at a gap, and is never bridged.
   - **The clip covers the painted stroke, not just the centre line.** A kept
     leg running just outside a circle still paints half its stroke width
     inside it. So the geometric clip uses the circle radius **plus half the
     widest stroke** (the 14 px under-stroke, 7 px), converted to metres at
     the final fit scale. The fit scale depends on what is kept, so this
     iterates: fit, enlarge, clip, refit. It converges in two or three passes,
     because enlarging only shrinks the kept bounding box.
   - As a second, independent guard, `drawCard` clips the canvas before
     stroking the route. Successive `clip()` calls intersect, so it is:
     1. clip to the route box;
     2. for **each** circle separately, clip to (route box + that circle) with
        the `evenodd` rule, i.e. the box minus that one circle. Each circle is
        at exactly 300 m in card pixels.

     The result is the box minus both circles, however they sit.
     - A single `evenodd` path holding the box and both circles would be
       wrong: where the circles overlap, the winding count is odd again and
       the overlap is painted. When start and finish coincide (any loop from
       the door), the two holes cancel out entirely.
     - `evenodd` and nested `clip()` both work in Safari 15.

     No pixel of any stroke can land inside a circle, whatever the geometry
     step did.
   - Trimming only the first and last 300 m along the route (`cumKm`) was the
     first idea. It fails exactly where it matters: laps from the front door
     and out-and-backs pass home mid-run, and an end trim leaves those passes
     drawn, pointing at the door.
   - The mask makes each pass near the start or finish disappear. Each visible
     piece of line ends on a circle's edge, in whatever direction the route
     left.
   - When the mask leaves too little (under ~200 m of line in total, e.g.
     a short loop around the block), A isn't offered. The 200 m is summed
     from the kept legs in projected metres. It is only a gate for drawing,
     never a distance shown to anyone, so it doesn't compete with the one
     distance definition. A is never drawn without the mask.
   - No start or finish dots: they would sit on the edge of the hidden circle
     and point at its centre.
   - The builder says so under the Route preview, in one line with a shield
     icon (`shareCard.privacyNote`: "For your privacy, the line leaves out
     300 m around where you started and finished."). It shows only while a
     route is drawn, so no other style claims a mask it doesn't need.
   - **Why no switch** (maintainer, 2026-11-26): the card has no map, but a
     recognisable shape can still be laid over one, and most runs start at a
     front door. Hiding can't be turned off, so the builder has one control
     fewer and no unsafe option.
   - **What the copy may claim**, should a line ever explain it: "The line
     leaves out 300 m around where you started and finished." That is exactly
     what it does.
   - **What it doesn't hide**, and the copy doesn't imply it does:
     - a place the route passes that is neither start nor finish (a run that
       started from work passes home mid-run);
     - a recognisable route shape;
     - a place within ~300 m of home deduced from the hidden circle's
       position.

     Any copy about it says "start and finish", never "your home".
5. **Fit** to the route box (308×300 design px), centred, uniform scale, with
   padding for the 14 px under-stroke. No dots (step 4). Fitting is a
   uniform scale of what the mask kept, so it can't bring a hidden part back.

No coordinates leave the device: the card is pixels, and nothing about the
route is sent anywhere.

## Sharing: web vs native (`shareImage.ts`)

`shareImage(blob, fileName, text?): Promise<"shared" | "saved" | "dismissed" | "failed">`
is one seam, and the builder never branches on the platform.

| Where | How | Notes |
| --- | --- | --- |
| Web, `navigator.canShare({ files })` true (Safari on iOS, Chrome on Android) | `navigator.share({ files: [file], text })` | The share text (below) rides along. |
| Web, no file sharing (desktop Firefox, most desktop browsers) | download through an object URL + `<a download>` | Result `"saved"`, button reads "Download image". |
| **Native (both shells)** | `@capacitor/filesystem` writes the PNG to `Directory.Cache`, then `@capacitor/share` `Share.share({ files: [uri] })` | Android System WebView has no `navigator.share` at all (today's `useShareLink` falls back to the clipboard for this reason), and file sharing from WKWebView isn't reliable. |

- An `AbortError` (the runner closed the sheet) is `"dismissed"`: a decision,
  not a failure, same rule as `useShareLink`.
- Saving to the photo library is left to the share sheet itself ("Save image"
  is in both OS sheets). We don't ask for any photos permission.
- Cache files are named `share-card-<runId>.png` and overwritten, so they don't
  pile up.
- **Share text**: one localized line with a link, e.g. "Tracked with Running
  Coach: https://run.camboulive.solutions/get?src=share-route".
  - Messaging apps and mail keep it next to the image. Instagram stories and
    similar drop it, which is harmless: the card already names the app.
  - The link is the flyer QR's `/get` redirect (`docs/store-redirect.md`), so
    each phone lands on its own store or the web app.
  - `src` is tagged per style (`share-route`, `share-number`, `share-week`).
    The weekly digest already lists `/get` visits by `src`, so it shows which
    card style brings people in, with no extra analytics.
  - In Play's acquisition report these visits arrive as `utm_medium=qr` (the
    redirect's fixed medium); `utm_source` still tells them apart.
  - The native path (PR 2) passes the same text to `Share.share`.
  - The download fallback has no text: there is no sheet to carry it.

**What the native plugins mean for a release:**

- Two new official plugins (`@capacitor/share@8`, `@capacitor/filesystem@8`,
  matching our Capacitor 8) mean `npx cap sync` and **a store release of both
  shells**. The web bundle ships inside the shells, so a bundle never meets an
  older shell without the plugin. Every call is still gated on
  `Capacitor.isPluginAvailable("Share")` **and**
  `Capacitor.isPluginAvailable("Filesystem")` (CLAUDE.md: gate every native call
  on its own availability check). `canShareImage()` needs both, and each call
  site still checks its own plugin. When either check fails, the share action
  is hidden rather than broken.
- Android: `Share` resolves the file through the app's existing FileProvider
  (`${applicationId}.fileprovider`, already in `AndroidManifest.xml`). Its
  `file_paths.xml` must cover the cache dir. To check in the PR, along with
  confirming the plugin doesn't `launch` a coroutine without a `catch` (CLAUDE.md:
  an uncaught exception in a plugin coroutine kills the process).
- iOS: no new permission or Info.plist key (we write to our own cache and present
  `UIActivityViewController`). Nothing new for App Review.
- Plugin proxies: never resolve a promise with one (`{ plugin }` boxing, as
  `getHealthConnect` does), and mock them as a proxy in tests.

## The builder (`ShareCardSheet`)

- Full-screen sheet over the caller (the canvas's `Flow-Composer`):
  - header "Share this run" + close button;
  - preview (the canvas element, 190×338 CSS px);
  - the offered style chips (Route · Number · Week);
  - switches;
  - the **Share image** button.
- `useDismissable` in its own component. Back/Escape closes the builder only, so
  back returns to the finish screen or the run detail.
- Switches, per the canvas:
  - **Show the route** (A only): off draws the stats-only layout.
  - **Show pace**, hidden for `km: 0` runs.

  On/off state is shown in colour (CLAUDE.md: orange on a tinted fill when on,
  grey when off) with `aria-pressed`. Switch state is per builder session, not
  persisted: one less synced setting, and each run starts from the safe
  defaults.
- Redraw on every model/style/switch change. Drawing a 360-unit card is cheap,
  and the export redraws at k = 3 only on Share.
- Share button shows a busy state while the PNG is encoded and the sheet is
  open. A `"failed"` result toasts a short error. `"dismissed"` does nothing.

**Finish screen.** `RunCelebration` auto-closes after 4 s and on any tap, and
sharing must survive both:

- **Share this run** is a real button above Continue. Its click doesn't bubble
  to the backdrop's close.
- Opening the builder **cancels the auto-close**. The celebration then lingers
  like a best-effort screen, so closing the builder lands back on it with
  Continue.
- `RunCelebration` owns the builder's open state and mounts it as a child, above
  its own `z-[2000]`.
- The run is unsaved at that point. The card needs nothing saved: the
  recorder already passes the measured `run` and `points` it gave
  `celebrate()`.
- The indoor recorder mounts the same screen and offers B/D only (no trace).

**Run detail.** A share icon button in `RunDetailModal`'s header
(`aria-label`), next to close. The builder gets the run, the fetched route,
`runs`, `plan`, `settings` and participations. The modal's props grow by
`plan`/participations, passed from the hub's `shared` bag.

**Where it's offered**: wherever `canShareImage()` is true. That means web
always (share or download), and native once the plugin is available. Not
premium: sharing is growth, and it is free like live sharing.

## i18n (en, fr, es)

- One new namespace, `shareCard.json`, in all three locales. The parity test
  covers it.
- Copy rules: French `tu`, Spanish informal and region-neutral, no em dashes
  (lint), sentence case, plain words first ("Number", not "Hero stat").
- `sortie`/`entrenamiento` for the run. `course`/`carrera` only for the race on
  D.
- Strings drawn into the image are still `t()` strings: the card is in the
  runner's language, rendered with the same plurals ("1 day to go" / "41 days to
  go").
- Layout must survive the longest locale:
  - `wrapText` with max lines and ellipsis for the race name (2 lines) and the
    headline (2 lines);
  - stat labels auto-shrink to fit their column (down to a floor) before
    ellipsing.
  - A test draws every style in all three locales with a fake `measureText`
    and asserts nothing overflows its box.
- The `latin-ext` subsets of Archivo and Inter cover fr/es and most European
  race names. A name with
  glyphs outside it (Cyrillic, CJK) falls back to the platform font for those
  glyphs. That's acceptable and noted in the code.

## Accessibility

- The preview canvas has `role="img"` and an `aria-label` built from the model
  (e.g. "Card: 10.4 km in 52:18, 5:02 per km, route shown"), updated with the
  style.
- Style chips are `<button aria-pressed>` in a `role="group"` labelled "Card
  style". Switches are buttons with `aria-pressed` and a visible label. Every
  target is ≥44 px.
- Card text contrast meets 4.5:1 at the design's sizes (slate on orange ≈ 7:1,
  light on slate ≈ 15:1). The 11 px grey labels use `#94a3b8` on `#0b1220`
  (≈ 7:1).
- No motion beyond the sheet's enter animation. `prefers-reduced-motion` is
  already global.
- The exported image carries no alt text: the share APIs we can use don't
  offer it. Accepted.

## Analytics: which style, and did the runner change it

What the digest needs, per week:

- builder opens, by entry point (finish / detail);
- images shared;
- the pre-selected style vs the style shared;
- the share rate of each pre-selection when it was kept vs changed.

### Where the counts come from: the trade-off

| | Product analytics (PostHog `track`) | Server-side anonymous counter |
| --- | --- | --- |
| Coverage | Consenting users only, an unknown, shifting fraction | Every share, every user |
| Readable by `admin_metrics()` | No (the digest reads the database, `docs/product-metrics.md`) | Yes, like `qr_scans` and `live_broadcasts` |
| Consent | Already covered by the analytics opt-in | None needed **only if** the row can't be tied to a person: no user id, no device id, nothing free-text |
| Per-user questions (do sharers retain?) | Yes, for the consenting slice | No, by design |
| Cost | Zero new infra | One small table, one grant and insert policy, a digest section |

PostHog alone can't answer "what share of runners changed the style", because
the denominator is unknown. And the digest is defined as database truth
precisely because analytics undercount. The project already counts
non-personal aggregates server-side without consent (`qr_scans` stores no IP or
user agent; `live_broadcasts` feeds the digest).

**Recommendation: a server-side anonymous counter as the digest's source.**
Plus the usual PostHog `track` events for consenting users, for funnels the
counter can't do. The counter must stay non-personal for this to be honest, so
the row shape is fixed:

```sql
create table public.share_card_events (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  event       text not null check (event in ('opened', 'shared', 'saved', 'closed')),
  entry       text not null check (entry in ('finish', 'detail')),
  preselected text not null check (preselected in ('route', 'number', 'week')),
  chosen      text check (chosen in ('route', 'number', 'week')),
  platform    text not null check (platform in ('web', 'ios', 'android')),
  first_share boolean,
  check ((event = 'opened') = (chosen is null)),
  check ((event = 'opened') = (first_share is null))
);

grant insert on public.share_card_events to authenticated;
```

- **No `user_id`**, no device id, no run id, no free text. `changed` is
  derived (`chosen <> preselected`).
- **One row per event**, never one per builder session:
  - `opened` when the builder mounts, with no `chosen`;
  - `shared` or `saved` on each successful hand-off, with the style handed
    off as `chosen` and `first_share` set. Sharing two styles from one builder visit writes two
    rows, so every shared style reaches the digest.
  - `closed` when the builder closes **without** any hand-off, with the style
    on screen at that moment as `chosen` and `first_share` false. So a visit
    that didn't share still says whether the runner had changed the style.
  - A dismissed share sheet or a failure writes nothing of its own.
  - `first_share` is true on the first hand-off of a builder visit, and false
    on any later one. It is a flag kept in the builder's memory, so no session
    key is stored, which would be a per-device identifier in all but name.
  - Visits that shared = `shared`/`saved` rows with `first_share`. Visits that
    didn't = `closed` rows.
  - Share rate when the pre-selection was kept vs changed: for each group
    (`chosen = preselected` or not), first-share rows divided by first-share
    rows plus `closed` rows. Opens minus both counts gives the visits whose
    closing row was lost (app killed, failed insert).
  - Approximate: a failed insert, or a visit that crosses midnight at a week
    boundary, can skew one count. The digest already labels these counts
    approximate.
- Write path:
  - `enable row level security`;
  - one `insert` policy `to authenticated with check ((select auth.uid()) is not null)`
    (refuses the anon key, and isn't an "always true" policy for the linter);
  - `grant insert ... to authenticated`. `auto_expose_new_tables` is unset,
    so a new table gets **no** grants on the hosted project
    (`docs/live-sharing.md`), and without the grant every insert fails even
    though the policy allows it;
  - `revoke select, update, delete ... from anon, authenticated`.

  The client inserts with supabase-js and destructures `error`
  (`local/supabase-check-error`). A failed insert is dropped silently: no
  retry queue, never blocks or toasts. Counts are approximate and can be
  inflated, like `qr_scans`. The digest says so.
- No edge function and no `security definer`. `admin_metrics()` (already
  definer) adds a `share_card` field: last 7 days and all time for opens by
  entry, shares, and a pre-selected × chosen table. `formatDigest` gets a
  section, omitted when the field is absent (same pattern as `qr`).
- PostHog (consenting only, through `src/telemetry`): `share_card_opened`
  `{entry, preselected}` and `share_card_shared` `{entry, preselected, chosen,
  event}`. No run data, no text.

**Decided: option (a).** The maintainer's rule is "count everything, as long as
it is anonymous". The options as they were weighed follow. The counter adds an
automatic, consent-free server write to the client. CLAUDE.md and
`docs/telemetry.md` say anything that collects automatically belongs to one of
the two consent channels, "never a borrowed consent". Neither document carves
out non-personal ledgers today. `qr_scans` and `live_broadcasts` count without
consent, but that is a practice, not a documented rule. So the counter
**doesn't ship on the strength of the precedent alone**. PR 3 takes one of
these, and you choose which:

- **(a) Document the exception first.** PR 3 adds a "Non-personal server
  counters" section to `docs/telemetry.md`, before the insert exists, defining
  what qualifies:
  - no user, device, run or session id;
  - no free text and no location;
  - only enumerated values;
  - aggregate reads only (`admin_metrics()`).

  It lists `qr_scans`, `live_broadcasts` and `share_card_events` under it, and
  CLAUDE.md's telemetry line points to it. The digest gets whole counts, and
  the rule becomes written instead of implied. **Chosen.**
- **(b) Gate the insert on analytics consent** (`getConsent()`). No new
  rule is needed, but the table then undercounts exactly like PostHog,
  which takes away the reason to build it.
- **(c) PostHog only.** No table. The digest states the consenting-slice
  caveat, fetched through PostHog's query API, which `admin-metrics` doesn't
  use today.

## Test plan

Unit tests (`.ts` suites in the node environment, no jsdom):

- `cardModel.test.ts`:
  - `cardStyles` for every rule and fallback: PB → B; first effort isn't a PB;
    settled session → D; settled but post-race phase → not D; settled but
    run from an earlier week → not D; run earlier this week → weekday label,
    not "Today"; trace → A; no
    trace → B; indoor → B; estimated effort never gets the pill.
  - Each style's model with: GPS run, manual run, indoor `km: 0` (no pace, no
    distance anywhere), open/block plan, no plan, race day, still-open sessions
    as neutral.
  - Plan fixtures pin the clock and run over both `ANCHORS`.
- `routeShape.test.ts`:
  - the mask drops every pass near the start or finish, not just the ends: a
    lap course and an out-and-back from the start draw nothing within 300 m of
    it, and a mid-run pass near a point that is neither stays drawn;
  - the masked line breaks rather than bridges, and has no start/finish dots;
  - a single leg whose two ends are both outside a circle but which cuts
    through it is split, with no drawn point inside 300 m;
  - masking runs after simplification: no kept segment comes within 300 m of
    the start or finish;
  - a route crossing the antimeridian near its start still keeps every stroke
    out of both circles;
  - a short loop fully inside the mask → A not offered;
  - a leg running parallel to a circle, just outside its 300 m edge, is
    clipped by the enlarged radius. The recorded `drawCard` calls set the box
    clip and then one exclusion clip per circle before any route stroke;
  - **pixel tests** (`routeMask.pixel.test.ts`). These render the route
    layer onto a real canvas and sample pixels inside each circle, which must
    all be transparent. Three cases: separate circles, overlapping circles, and
    coincident start/finish (the loop case that breaks a single `evenodd`
    path).
    - jsdom has no canvas and CI has no browser, so the suite uses
      `@napi-rs/canvas`. It has prebuilt binaries and needs no browser or
      system libraries. **This is a new dev-only dependency, added in PR 1**,
      and never shipped in the bundle.
    - Its clip semantics follow the same Skia engine as Chrome and Android
      WebView. WebKit is covered by the by-hand check on iOS.
  - `simplify` receives lat/lng tuples, never projected metres (a fixture
    whose result is checked in point count and against `perpM` tolerance);
  - gaps stay breaks;
  - projection keeps the aspect ratio;
  - the fit stays inside the box;
  - point count stays bounded for a marathon-length trace;
  - a degenerate trace (one point) → A not offered.
- `drawCard.test.ts`, with a recording fake context (the calls are the
  assertions, since node has no canvas):
  - no route path when the switch is off;
  - no pace text when off or on `km: 0`;
  - `roundRect` never called as a native method (the iOS 15 floor);
  - every text draw fits its box in en/fr/es.
- `shareImage.test.ts`:
  - web share with `canShare` true and false (download);
  - `AbortError` → `"dismissed"`;
  - native path with the plugins mocked **as a proxy**;
  - plugin unavailable → share hidden.

Component (`.tsx`, jsdom):

- `ShareCardSheet.test.tsx`:
  - pre-selected chip pressed;
  - switching style re-labels the preview's `aria-label`;
  - back/Escape closes via `useDismissable`;
  - the builder tolerates `getContext` returning null (jsdom).
- `RunCelebration.test.tsx`: the Share button doesn't close the screen, and
  opening the builder cancels the auto-close.

PR 3:

- `src/migrations.test.ts` and `src/migrationConventions.test.ts` cover the new
  migration (version via `supabase migration new`).
- Digest formatting test for the new section, including absent → omitted.

By hand: share from the finish screen and the run detail on web (Chrome
Android, Safari iOS, desktop download), Android and iOS shells (Instagram story,
WhatsApp, save to photos), each style, all three locales.

## PR split

Three PRs (decided). The native plugins get their own PR, so the
store-release effect sits alone in a small one:

1. **Card + builder + web sharing.**
   - `src/share/*` (model, route shape, drawing, web half of `shareImage`);
   - `ShareCardSheet`;
   - both entry points;
   - the race-label helper moved out of `Dashboard.tsx`;
   - i18n in all three locales;
   - `@fontsource/inter` and `@napi-rs/canvas` (dev only) as new dependencies.

   `canShareImage()` is false on native, so the shells show no Share button
   yet and need no release. Web users get the whole feature.
2. **Native sharing.**
   - `@capacitor/share` + `@capacitor/filesystem`, the native half of
     `shareImage`, `cap sync`, and the FileProvider path check;
   - flips the entry point on in the shells.

   Merge-time effect: needs a store release of both shells.
3. **Analytics + digest.**
   - the "Non-personal server counters" section in
     `docs/telemetry.md`, in the same PR and ahead of the insert;
   - the `share_card_events` migration (with its `authenticated` insert
     grant);
   - the client write in `ShareCardSheet`, plus the two PostHog events;
   - `admin_metrics()` and `formatDigest`;
   - a "Share card" section in `docs/product-metrics.md`.

   It lands after PR 1, which creates the builder its client write goes into.
   Ideally merged right after it, so the counts start close to the feature.

Each PR: lint, `typecheck:all`, tests and build green. This doc is updated from
"design" to reference as the parts land, and CLAUDE.md gets a one-line rule only
if one turns out to be cross-cutting.

## Decisions (maintainer, 2026-11-22)

1. **Analytics source: the anonymous counter**, option (a). The rule is
   "count everything, as long as it is anonymous". PR 3 writes that rule into
   `docs/telemetry.md` before the insert exists.
2. **PR split: three PRs**, native sharing on its own.
3. **Start time: date only** on the card.
4. **Fonts: Archivo + Inter**, as in the canvas.
