#!/bin/bash
# Everything an agent session (or a fresh checkout) needs to run the repo's own
# checks: npm run lint, test, typecheck, typecheck:supabase, build.
#
# Safe to run repeatedly and safe to run as a Claude Code environment setup
# script or from the SessionStart hook — each step is skipped when it is
# already satisfied.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-.}")/.." 2>/dev/null && pwd || pwd)}"

log() { printf '\n▸ %s\n' "$1"; }

# ── npm dependencies ────────────────────────────────────────────────────────
# `npm ci`, not `npm install`: postinstall runs patch-package, and patch-package
# cannot re-apply a patch to an already-patched tree. A clean install always
# starts from pristine packages, so the native plugin patches actually land.
# Skipped only when node_modules was installed from this exact lockfile AND
# these exact patches — `npm ls` alone passes a tree whose patch just changed.
stamp_file=node_modules/.setup-env-stamp
deps_stamp=$(cat package-lock.json patches/*.patch 2>/dev/null | sha256sum | cut -d' ' -f1)
if [ -f "$stamp_file" ] && [ "$(cat "$stamp_file")" = "$deps_stamp" ]; then
  log "npm dependencies up to date"
else
  log "Installing npm dependencies (npm ci)"
  npm ci --no-audit --no-fund
  echo "$deps_stamp" >"$stamp_file"
fi

# ── Deno ────────────────────────────────────────────────────────────────────
# `npm run typecheck:supabase` (part of typecheck:all, which CI runs) is a
# `deno check`. Installed from npm's `deno` package rather than deno.land's
# install.sh: the cloud sandbox's egress proxy allows the npm registry but
# refuses deno.land and GitHub release downloads. Only that check needs Deno, so
# a failure degrades to a warning instead of aborting the SessionStart hook.
DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
deno_bin="$DENO_INSTALL/lib/node_modules/deno/deno"
if ! command -v deno >/dev/null 2>&1 && [ ! -x "$deno_bin" ]; then
  log "Installing Deno (npm: deno@2)"
  # Warnings go to stdout: a SessionStart hook's stderr never reaches the session.
  if ! npm install -g --prefix "$DENO_INSTALL" --no-audit --no-fund deno@2 2>&1 | tail -n 5; then
    log "Deno install FAILED — npm run typecheck:supabase will not run"
  fi
fi
# Tool calls and CI run non-interactive shells, which source no rc file, so the
# binary has to be on the default PATH.
if ! command -v deno >/dev/null 2>&1 && [ -x "$deno_bin" ]; then
  if [ -w /usr/local/bin ]; then
    ln -sf "$deno_bin" /usr/local/bin/deno
  else
    log "Deno is at $deno_bin — add its directory to PATH"
  fi
fi
command -v deno >/dev/null 2>&1 && log "Deno ready ($(deno --version | head -1))"

# ── Playwright ──────────────────────────────────────────────────────────────
# Chromium is preinstalled in the cloud image (PLAYWRIGHT_BROWSERS_PATH); never
# download another copy. Only report what the screenshot tooling will find.
if [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -d "${PLAYWRIGHT_BROWSERS_PATH}" ]; then
  log "Playwright browsers: ${PLAYWRIGHT_BROWSERS_PATH} (preinstalled)"
fi

log "Ready. Checks: npm run lint · npm test · npm run typecheck:all · npm run build"
