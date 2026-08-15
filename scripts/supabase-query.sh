#!/usr/bin/env bash
# Run one SQL statement against the linked Supabase project and print the rows
# (JSON) on stdout. Used by the release workflow's staging steps and by
# publish-version.yml.
#
# Deliberately talks to the Management API rather than `supabase db query
# --linked`: both that and `supabase link` first fetch GET /v1/projects/{ref}/
# api-keys, and the CLI rejects the response whenever a key's `inserted_at`
# isn't RFC3339-with-Z ("failed to get api keys: SchemaError(...)"). That broke
# release run 45 AFTER both stores had the build — the CLI never reached the
# SQL. The endpoint below is the one the CLI ends at anyway, so dropping the
# detour removes the whole failure class (and the npx download with it).
#
# Transient failures are retried, so callers must keep their SQL idempotent.
set -euo pipefail

SQL="${1:-}"
if [ -z "$SQL" ]; then
  echo "::error::supabase-query.sh: no SQL given." >&2
  exit 1
fi
if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "::error::SUPABASE_ACCESS_TOKEN repo secret is not set — add a Supabase personal/service access token with database query rights on run-app." >&2
  exit 1
fi
if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  echo "::error::SUPABASE_PROJECT_REF repo variable is not set." >&2
  exit 1
fi

body=$(mktemp)
trap 'rm -f "$body"' EXIT

code=$(
  jq -n --arg q "$SQL" '{query: $q}' |
    curl -sS -o "$body" -w '%{http_code}' \
      --retry 3 --retry-delay 2 --retry-connrefused --max-time 60 \
      -X POST "https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query" \
      -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
      -H "Content-Type: application/json" \
      --data-binary @-
)

if [ "$code" -lt 200 ] || [ "$code" -ge 300 ]; then
  echo "::error::Supabase query failed (HTTP $code): $(cat "$body")" >&2
  exit 1
fi

cat "$body"
