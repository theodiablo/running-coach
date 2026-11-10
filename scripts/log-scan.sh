#!/usr/bin/env bash
# Daily Supabase log and security-advisor scan: silent on a quiet day, exit 1 on an
# anomaly so GitHub notifies. Detail and tuning: docs/monitoring.md.
#
# Needs SUPABASE_LOGS_TOKEN (scoped: Logs Read + Advisors Read on this project
# only) and SUPABASE_PROJECT_REF. Output is counts and codes only: CI summaries
# on this repo are public.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
api="https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF:?}"
summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

# WARN/ERROR findings already reviewed, as lint:object. INFO lints are not checked.
ACCEPTED_LINTS='authenticated_security_definer_function_executable:delete_my_account
auth_leaked_password_protection:Auth'

get() {
  curl -fsS --get --max-time 60 -H "Authorization: Bearer ${SUPABASE_LOGS_TOKEN:?}" "$@"
}

end="$(date -u +%Y-%m-%dT%H:%M:00Z)"
start="$(date -u -d "$end - 24 hours" +%Y-%m-%dT%H:%M:00Z)"
sql="$(grep -v '^--' "$here/log-scan.sql")"

logs="$(get "$api/analytics/endpoints/logs" \
  --data-urlencode "sql=$sql" \
  --data-urlencode "iso_timestamp_start=$start" \
  --data-urlencode "iso_timestamp_end=$end")" || {
  echo "::error::Log query failed (token expired or missing a scope?)"
  exit 1
}
if [ "$(jq -r '.error // empty | tostring' <<<"$logs")" != "" ]; then
  echo "::error::Log query error: $(jq -c '.error' <<<"$logs")"
  exit 1
fi
anomalies="$(jq -c '.result // [] | sort_by(-(.n | tonumber))' <<<"$logs")"
n_anomalies="$(jq 'length' <<<"$anomalies")"

# Experimental endpoint: a failure here warns rather than alerts.
new_lints="[]"
if advisors="$(get "$api/advisors/security")"; then
  new_lints="$(jq -c --arg accepted "$ACCEPTED_LINTS" '
    ($accepted | split("\n")) as $ok
    | [.lints[]? | select(.level != "INFO") as $l
       | ($l.findings // [{}])[]
       | "\($l.level) \($l.name):\(.metadata.name // .metadata.entity // "")"
       | select((split(" ")[1]) as $k | $ok | index($k) | not)]' <<<"$advisors")"
else
  echo "::warning::Security advisors unavailable; logs were still scanned."
fi
n_lints="$(jq 'length' <<<"$new_lints")"

{
  echo "## Supabase log scan"
  echo
  echo "Window: \`$start\` to \`$end\`"
  echo
  if [ "$n_anomalies" = "0" ] && [ "$n_lints" = "0" ]; then
    echo "Nothing above threshold."
  fi
  if [ "$n_anomalies" != "0" ]; then
    echo "| Source | Code | What | Count |"
    echo "| --- | --- | --- | --- |"
    jq -r '.[] | "| \(.src) | \(.code) | `\(.what)` | \(.n) |"' <<<"$anomalies"
    echo
  fi
  if [ "$n_lints" != "0" ]; then
    echo "New security advisor findings:"
    echo
    jq -r '.[] | "- `\(.)`"' <<<"$new_lints"
  fi
} >> "$summary"

if [ "$n_anomalies" != "0" ] || [ "$n_lints" != "0" ]; then
  echo "::error::Supabase needs a look: $n_anomalies log anomaly row(s), $n_lints new advisor finding(s). See the job summary."
  exit 1
fi
