#!/usr/bin/env bash
# Runs SQL against the Closer OS Supabase project through the Management API.
# Usage: scripts/db-apply.sh file.sql        (run a file)
#        scripts/db-apply.sh -c "select 1"   (run a statement)
set -euo pipefail
REF="${SUPABASE_PROJECT_REF:-tdbqgoxxxfkfttdznzhb}"
: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is not set}"
if [ "$1" = "-c" ]; then SQL="$2"; else SQL="$(cat "$1")"; fi
BODY=$(python3 -c 'import json,sys; print(json.dumps({"query": sys.stdin.read()}))' <<<"$SQL")
OUT=$(curl -sS -w '\n%{http_code}' -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d "$BODY")
CODE="${OUT##*$'\n'}"; RES="${OUT%$'\n'*}"
echo "$RES"
[ "$CODE" -lt 300 ] || { echo "HTTP $CODE" >&2; exit 1; }
