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
# cannot re-apply a patch to an already-patched tree — it reports "cannot apply"
# and exits non-zero, which is what a warmed/cached node_modules produces on
# every later run. A clean install always starts from pristine packages, so the
# native plugin patches (the GPS fix journal, the BLE HR journal) actually land.
if [ -f package-lock.json ]; then
  if [ -d node_modules ] && npm ls --depth=0 >/dev/null 2>&1; then
    log "npm dependencies already installed"
  else
    log "Installing npm dependencies (npm ci)"
    npm ci --no-audit --no-fund
  fi
else
  log "Installing npm dependencies (npm install)"
  npm install --no-audit --no-fund
fi

# ── Deno ────────────────────────────────────────────────────────────────────
# The edge functions are Deno TypeScript; `npm run typecheck:supabase` (part of
# typecheck:all, which CI runs) is a `deno check` and fails with
# "deno: not found" without this.
DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
if [ ! -x "$DENO_INSTALL/bin/deno" ] && ! command -v deno >/dev/null 2>&1; then
  log "Installing Deno"
  export DENO_INSTALL
  # From a temp CWD: the installer runs `deno run jsr:@deno/installer-shell-setup`,
  # which writes that dependency into the lockfile of whatever directory it starts
  # in — started at the repo root, every cold container rewrites deno.lock.
  # Kept out of `set -e`, and its output kept: only typecheck:supabase needs Deno,
  # so a failure here must degrade to a warning rather than abort the script (and
  # with it the SessionStart hook that runs it) with nothing printed.
  deno_log=$(mktemp)
  if ( cd "$(mktemp -d)" && curl -fsSL https://deno.land/install.sh | sh -s -- -y ) \
      >"$deno_log" 2>&1; then
    :
  else
    log "Deno install FAILED — npm run typecheck:supabase will not run. Installer said:"
    tail -n 20 "$deno_log" >&2
  fi
  rm -f "$deno_log"
fi
# Reachable from a NON-INTERACTIVE shell, which is what tool calls and CI use:
# the installer only edits the shell rc files, and those are not sourced there,
# so without this every later `npm run typecheck:supabase` still says
# "deno: not found" — and this script would reinstall Deno on every run.
if [ -x "$DENO_INSTALL/bin/deno" ] && ! command -v deno >/dev/null 2>&1; then
  if [ -w /usr/local/bin ]; then
    ln -sf "$DENO_INSTALL/bin/deno" /usr/local/bin/deno
  else
    log "Deno is at $DENO_INSTALL/bin/deno — add it to PATH"
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
