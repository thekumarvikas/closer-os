#!/usr/bin/env bash
# Deploys a Supabase edge function from supabase/functions/<name>/index.ts.
# Usage: scripts/deploy-function.sh lead-webhook [--no-verify-jwt]
set -euo pipefail
NAME="$1"; VERIFY=true; [ "${2:-}" = "--no-verify-jwt" ] && VERIFY=false
REF="${SUPABASE_PROJECT_REF:-tdbqgoxxxfkfttdznzhb}"
cd "$(dirname "$0")/../supabase/functions/$NAME"
curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/functions/deploy?slug=$NAME" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -F "metadata={\"entrypoint_path\":\"index.ts\",\"name\":\"$NAME\",\"verify_jwt\":$VERIFY};type=application/json" \
  -F "file=@index.ts;type=application/typescript"
echo
