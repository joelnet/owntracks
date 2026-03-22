#!/bin/sh
set -a
. "$(dirname "$0")/../.env"
set +a

LAT="${1:?Usage: curl-location.sh <lat> <lon>}"
LON="${2:?Usage: curl-location.sh <lat> <lon>}"

curl -s -X POST http://localhost:3000/pub \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(printf '%s:%s' "$OWNTRACKS_USERNAME" "$OWNTRACKS_PASSWORD" | base64)" \
  -H "X-Limit-D: debug" \
  -d "{\"_type\":\"location\",\"lat\":$LAT,\"lon\":$LON,\"tst\":$(date +%s)}"
echo
