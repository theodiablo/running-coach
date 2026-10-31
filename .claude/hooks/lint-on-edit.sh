#!/bin/bash
# PostToolUse: lint the file just edited so a rule breach comes back to the agent at once.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
file=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const i=JSON.parse(s).tool_input||{};process.stdout.write(i.file_path||i.notebook_path||"")}catch{}})')
case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.json) ;;
  *) exit 0 ;;
esac
[ -f "$file" ] && [ -x node_modules/.bin/eslint ] || exit 0
out=$(node_modules/.bin/eslint --no-warn-ignored --cache --cache-location node_modules/.cache/eslint/ "$file" 2>&1) && exit 0
echo "$out" >&2
exit 2
