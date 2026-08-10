# The retention loop: overdue sessions and training reminders

Why the app tells you a session is still open, and how it pings you before the
next one. Read this before touching `src/utils/overdue.ts`,
`src/utils/sessionReminders.ts`, `src/notify/sessionReminders.ts`, or the
reminder copy.

## The problem this exists to solve

Measured on production (Supabase + PostHog, 2026-08-07): **17 of 19 users
generated a training plan, 9 ever logged a run, 4 logged three or more.** Average
active lifespan was 4.3 days, and of the 11 users who had a full 14-day window to
stick around, 3 were still active after a week.

Activation was never the problem; week-one retention was. And the app had
nothing to help:

- Nothing ever reached a user who was not already holding the app open. No
  scheduled notification, no calendar export, no digest.
- Worse, `Dashboard.tsx` filtered its next-session card to `date >= today`, so a
  session missed yesterday *silently vanished*. The card skipped to the next
  future session and the plan quietly drifted out of sync with reality.

Two halves, therefore: make the app honest about what you missed (universal),
and give it a way to call you back (native).

## Part A — Overdue sessions

**Overdue is derived, never stored.** `PlanSession` carries `done` / `skipped`
and nothing else, so a plan rebuild or a coach edit can never leave a stale
`missed` flag behind. `src/utils/overdue.ts` is the only definition:

- `overdueSessions(plan, today)` — untouched sessions dated before today, **most
  recent first** (the freshest miss is the one worth acting on). Returns
  everything; capping is the caller's job.
- `nextSession(plan, today)` — the soonest untouched session from today onward.
  Extracted from Dashboard so the two selectors are tested against each other:
  a session must never appear in both.
- `overdueByWeek(plan, today)` — per-week counts, used by PlanView's collapsed
  past-week headers. PlanView must NOT recompute this inline: an inline
  "untouched sessions in an ended week" count and this one disagree about the
  current week, which is exactly the kind of drift a single definition exists
  to prevent.

**Surfaces.** Dashboard renders an overdue card above the next-session card,
showing at most `OVERDUE_SHOWN` (3) rows plus an "N more" link into the plan — a
runner returning after a month must not be met with a wall of guilt. Each row
offers Done / Skip; the card offers one "Adjust my plan" button into the coach,
which already handles "I missed the whole week" through propose-and-confirm.
PlanView badges any past week that still holds untouched sessions.

**Copy stance, and it is load-bearing.** `src/utils/badges.ts` deliberately
avoids streaks ("never a fragile 'don't break the chain' streak"). The overdue
surfaces hold the same line: amber, never red; "still open", never "missed";
the framing is *adjust the plan*, not *you failed*. A guilt mechanic would buy
a week of compliance and cost the user.

## Part B — Scheduled local notifications (native shells only)

Web gets nothing here, and the card is **absent** rather than disabled — there is
nothing a browser user could do with it. Native reach is roughly 10 of 25 users
today; that limitation is understood and accepted for v1.

### The split: pure math, thin bridge

- `src/utils/sessionReminders.ts` — everything that can be got wrong, device-free
  and unit-tested. `reminderSchedule(plan, prefs, now, max)` returns the full
  pending set, soonest first.
- `src/notify/sessionReminders.ts` — talks to the OS and nothing else. Mirrors
  `src/geo/notifications.ts`: native-gated, never throws, never blocks the app.

### Contracts worth not breaking

- **`MAX_PENDING = 32`.** iOS keeps at most **64** pending local notifications
  and silently drops the rest; a 12-week plan carries ~48 sessions. Half the
  budget leaves headroom, and since the set is re-synced on every plan change the
  tail is never far away.
- **`reminderId(sessionId)` must stay stable across launches.** Cancelling a
  reminder means re-deriving the same id later. It is a djb2-style hash folded
  into a positive 31-bit int because Android notification ids are Java ints.
  Collisions are possible in principle and harmless in practice — the worst case
  is one reminder replacing another, and the next sync restores it.
- **Cancel-then-schedule, never a diff.** A full replace is the only version that
  cannot leave a reminder behind for a session that was rebuilt, completed or
  deleted. It is only atomic against *itself*, so syncs are **serialised through
  a module-level promise chain**: two overlapping calls (marking a session done
  while a plan edit is in flight) could otherwise interleave as cancel-A,
  cancel-B, schedule-B, schedule-A, and the older call's schedule would reinstate
  a reminder for a session already done.
- **Scheduling is inexact on purpose.** A training reminder does not need minute
  precision, and `SCHEDULE_EXACT_ALARM` / `USE_EXACT_ALARM` invite a Play policy
  review for no benefit. Do not add them. (Verified: the plugin's own manifest
  declares neither — it merges in `RECEIVE_BOOT_COMPLETED`, which is what
  restores reminders after a reboot, plus `POST_NOTIFICATIONS` and `WAKE_LOCK`
  that we already declared.)

### The one rescheduling seam

`plan` is mutated from six places in `src/RunningCoach.tsx` (boot, `savePlan`,
`applyCoachPlan`, `toggleSess`, `skipSess`, restore). Rather than call the sync
from each — where the seventh would be forgotten — a **single effect** keyed on
`[plan, reminderKey]` derives the schedule.

This does not violate the no-setState-in-effects rule: syncing an *external*
system is exactly what an effect is for, and no state is set. `reminderKey` is
the serialized prefs **plus `i18n.language`** — the notification text is baked by
`t()` at schedule time, so without the language in the key up to 32 pending
reminders would keep the language they were written in after a switch.

**The effect must stay gated on `loading`, and that guard is load-bearing.**
`App.tsx` gating on `storeReady` is not enough: `RunningCoach` hydrates its own
state in an effect, so the first commit has `plan === null` and the hardcoded
default settings. An unguarded run therefore takes the disabled branch and
**cancels every pending reminder on any launch**, with restoration depending on a
second run that is not guaranteed (killed or backgrounded before boot resolves,
or a bridge error the sync deliberately swallows). This is the same hazard
`CLAUDE.md` documents for the store: an unpopulated state must never become a
destructive write.

### Preference vs per-device grant

The usual doctrine (identical to `watchImport` / `hrMethod`):

| | Where | Key |
|---|---|---|
| Wants reminders, at what time, how far ahead | **Synced** (`app_state`) | `settings.sessionReminders` / `reminderTime` / `reminderLeadDays` |
| This install has the OS grant | **Per-device** | `SESSION_NOTIF_AUTH_KEY` |
| This install has shown the disclosure | **Per-device** | `SESSION_NOTIF_DISCLOSED_KEY` |

Enabling on a second phone re-runs the disclosure and the OS prompt there. A
preference synced from another device says nothing about a permission on this
one, so both the UI and the bridge gate on the grant — and the grant itself is
re-read from the OS (`refreshReminderGrant`) rather than trusted from the
localStorage cache, which goes stale the moment the runner revokes notifications
in system settings.

Android reuses the `POST_NOTIFICATIONS` path already built for the run-recording
notification (`requestRunNotifications` in `src/geo/notifications.ts`, backed by
the local `RunPermissions` plugin). iOS prompts through the plugin and needs **no
new entitlement** — local notifications are OS-scheduled, so `App.entitlements`
and `UIBackgroundModes` are untouched and the iOS 15 floor is unaffected.

### Turning them off

Three independent routes, none of which can strand a pending reminder:

1. **The in-app toggle** (Training Profile). Flipping it off writes
   `sessionReminders: false`, which changes `reminderKey`, which fires the sync,
   which cancels everything pending. One tap, no OS round-trip, and no
   permission re-prompt on the way out.

   The toggle renders `prefs.enabled && granted`, never the preference alone.
   The preference is synced, so it arrives **true** on a freshly installed second
   phone where no grant exists and nothing is scheduled; showing "on" there would
   offer only "turn off" and leave no route to the permission prompt, under a
   card promising a reminder that could never fire.
2. **The OS.** Reminders go out on their own Android channel
   (`session-reminders`, "Training reminders"), deliberately *not* the
   run-recording notification's channel — so muting them in system settings
   silences reminders only and leaves the live-run notification intact. On iOS
   the app-level notification switch does the same.
3. **Revoking the OS permission.** Every sync calls `refreshReminderGrant()`,
   which asks `LocalNotifications.checkPermissions()` and re-caches the answer,
   so the next sync after a revoke tears the schedule down. The localStorage
   marker is a first-paint cache only — trusting it would leave the app
   "scheduling" into a permission it no longer holds.

Cancellation is **scoped to our own notifications**: every reminder carries
`extra.kind === "session-reminder"` and `cancelOurs()` filters on it, so turning
reminders off never clears something another feature scheduled. All three routes
are covered in `src/notify/sessionReminders.test.ts` and
`src/components/SessionRemindersCard.test.tsx`.

UI lives on the **Training Profile** settings sub-page
(`src/components/SessionRemindersCard.tsx`), next to HR zones and coach memory,
because it is training behaviour rather than an account setting.

## Measuring whether any of this worked

The feature exists to move two numbers, both already in PostHog:

1. `plan_generated` → `run_logged` conversion (was 17 → 9).
2. Share of users still active 7+ days after their first event (was 3 of 11,
   restricted to users with a full window — always correct for right-censoring
   before comparing).

`overdue_shown` / `overdue_resolved` (`docs/telemetry.md`) say whether the
backlog is being resolved or just displayed. If overdue cards are shown and never
resolved, the card is nagging rather than helping and the copy needs rethinking,
not amplifying.
