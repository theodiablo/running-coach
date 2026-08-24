#!/bin/bash
# SessionStart hook for Claude Code on the web: make the repo's own checks
# runnable without a manual setup step first. The work itself lives in
# scripts/setup-env.sh, which is also what to point a cloud environment's
# setup-script setting at.
set -euo pipefail

# Only needed in remote (web) sessions; local checkouts manage their own deps.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-.}")/../.." 2>/dev/null && pwd || pwd)}"
exec ./scripts/setup-env.sh
