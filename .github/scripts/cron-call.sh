#!/usr/bin/env bash
# Calls a Cheddar cron endpoint and always prints the response body, so failures
# in the GitHub Actions log show the real error instead of just `curl: (22)`.
#
# Env: APP_URL, CRON_SECRET, JOB_PATH (e.g. /api/cron/slack-resync)
set -euo pipefail

url="$(printf '%s' "${APP_URL:-}" | tr -d '[:space:]')"
url="${url%/}"
case "$url" in
  http://*|https://*) ;;
  "") echo "APP_URL secret is not set" >&2; exit 1 ;;
  *) url="https://$url" ;;
esac

secret="$(printf '%s' "${CRON_SECRET:-}" | tr -d '\r\n')"
if [ -z "$secret" ]; then
  echo "CRON_SECRET secret is not set" >&2
  exit 1
fi

body="$(mktemp)"
code="$(curl -sS -o "$body" -w '%{http_code}' -H "Authorization: Bearer $secret" "$url${JOB_PATH:-}")"
echo "HTTP $code"
cat "$body"
echo
if [ "$code" -ge 400 ]; then
  exit 1
fi
