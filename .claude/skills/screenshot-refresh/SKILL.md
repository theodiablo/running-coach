---
name: screenshot-refresh
description: Refresh the full-page design-review screenshots of the deployed Running Coach app (mobile + desktop) in screenshots/, using the standalone Playwright tool already committed there. Use this whenever the user asks to refresh, retake, redo, regenerate, or update the app's screenshots, wants a fresh screenshot pass for a design review, or asks for a full walkthrough capture of the app's screens.
---

# Screenshot refresh

`screenshots/` is a self-contained Playwright tool (its own `package.json`, not
part of the app build) that logs into `run.camboulive.solutions` and captures
every major screen full-page at 390×844 and 1440×900. `screenshots/README.md`
has the commands, the screens covered and the capture quirks; read it first.

## Check where you are before starting

The tool needs two things a cloud session usually lacks. Check both up front
and stop with a clear explanation if either fails. Don't try workarounds.

- **Network access** to `run.camboulive.solutions` and the project's
  `*.supabase.co`. A cloud environment's network policy may deny both, and then
  nothing loads. Test with `curl -sS -o /dev/null -w '%{http_code}' https://run.camboulive.solutions/`.
  If the host is denied, tell the user which host it is; they can allow it in
  the environment's network settings.
- **A human at a visible browser**, only when `screenshots/auth.json` is
  missing or expired. `login.js` opens a headed Chromium for the user to sign in
  themselves. A cloud session has no display, so the login has to happen on
  the user's own machine.

Never type credentials into the login window, even ones pasted in chat. Signing
in is always the user's step.

## Running it

1. `cd screenshots && npm install`.
2. Browser: when `PLAYWRIGHT_BROWSERS_PATH` is set (cloud images), the scripts
   use the preinstalled Chromium through `browser.js`. Don't run
   `playwright install` there. Elsewhere, run `npx playwright install chromium`
   once.
3. `node login.js` if there's no valid `auth.json`. Ask the user to sign in
   in the window that opens. `auth.json` is gitignored live session state and
   must never be committed.
4. `node capture.js` (or `capture:mobile` / `capture:desktop`).
5. Read a few of the new PNGs to sanity-check them. Most steps are wrapped in
   `isVisible()`, so a UI change usually skips a screenshot silently instead
   of failing.
6. Show `git diff --stat screenshots/` so the user can see what changed.

## When the UI has changed

`capture.js` clicks through by accessible names and English copy, for example
`Record a run`, `Settings`, `Close`, `Conversation history`, `Track a run live`
and the `Plan` / `Races` / `Progress` nav labels. If a screen is missing or
wrong, check the selector against `src/i18n/locales/en/*.json` and fix
`capture.js` in place. Don't route around it with one-off scripts.

## Before committing

The repo is public, and the screenshots show whatever account captured them:
name, runs, heart rate, races. Point this out to the user before committing a
refresh taken on a real account. Don't commit or push automatically; follow
the PR workflow in `CLAUDE.md`.
