<!--
Prose first: what was broken or missing, what changed, and why this shape.
Delete any section that doesn't apply — an empty heading is noise.
-->

## Summary

<!-- A few sentences. Lead with the user-visible problem or the goal, not the diff. -->

## What changed

<!-- One bullet per meaningful change, naming the module that owns it. -->

-

## Verification

<!-- CI runs all four, so an unticked box needs a reason. -->

- [ ] `npm run lint`
- [ ] `npm run typecheck:all`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Checked by hand: <!-- which flows, on web / Android / iOS -->

Tests: <!-- what regression the new/changed tests catch, or why none was needed -->

## Risks and follow-ups

<!-- What could break, what's deliberately out of scope, what needs watching after merge. -->

## Merge-time effects

<!--
Only for changes that reach outside the repo. Delete the section if none apply;
delete the lines that don't.
-->

- [ ] **`infra/`** — merging to `main` applies the Terraform plan to AWS. Plan reviewed, nothing destroyed or replaced (or dispatched with `allow_destroy`).
- [ ] **`supabase/migrations/`** — version created with `supabase migration new`, no pushed migration renamed or removed, applied with `supabase db push`.
- [ ] **`supabase/functions/`** — edge functions deploy on merge; any new secret or env var set on the project first.
- [ ] **`supabase/templates/`** — auth email templates are project config, synced to the hosted project by hand (`docs/release.md`).
- [ ] **Native shells** — needs a store release, a new permission, or a Play Console / App Store Connect declaration.
- [ ] **Premium** — the gate is server-side in the feature's edge function, and every new affordance is behind `isPremium || canShowPremiumTeaser`.
- [ ] **Docs** — `CLAUDE.md` and/or `docs/*.md` updated for anything durable this change establishes.

## Screenshots

<!--
Any UI change: before/after, dark palette, and a notched device for anything
pinned to a screen edge. The web preview URL is posted automatically as a
comment; add the `apk` label for an installable Android debug build.
-->
