#!/usr/bin/env bash
# crawl-page.sh — Submit a URL (with optional local HTML) to the remote crawler-worker for event extraction
#
# Usage: ./scripts/crawl-page.sh <url> [<html-file>] [--publish]
#
# By default runs in preview mode (events are extracted but not published).
# Pass --publish to actually publish the extracted events.
# If <html-file> is provided, its contents are sent as the rendered HTML (avoids a live fetch).
#
# Reads crawlerWorkerUrl and crawlerApiKey from config.local.js in the repo root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_JS="${REPO_ROOT}/config.local.js"

if [[ ! -f "$CONFIG_JS" ]]; then
  echo "Error: config.local.js not found." >&2
  echo "Copy config.local.js.example to config.local.js and fill in your values." >&2
  exit 1
fi

CRAWLER_WORKER_URL="$(node -e "console.log(require('${CONFIG_JS}').crawlerWorkerUrl)")"
CRAWLER_API_KEY="$(node -e "console.log(require('${CONFIG_JS}').crawlerApiKey)")"

URL="${1:-}"
HTML_FILE=""
PREVIEW=true

if [[ -z "$URL" ]]; then
  echo "Usage: $0 <url> [<html-file>] [--publish]" >&2
  exit 1
fi

for arg in "${@:2}"; do
  case "$arg" in
    --publish) PREVIEW=false ;;
    -*) echo "Unknown argument: $arg" >&2; exit 1 ;;
    *)  HTML_FILE="$arg" ;;
  esac
done

if [[ -n "$HTML_FILE" && ! -f "$HTML_FILE" ]]; then
  echo "Error: HTML file not found: $HTML_FILE" >&2
  exit 1
fi

if [[ -z "${CRAWLER_WORKER_URL:-}" ]]; then
  echo "Error: CRAWLER_WORKER_URL is not set" >&2
  exit 1
fi

if [[ -z "${CRAWLER_API_KEY:-}" ]]; then
  echo "Error: CRAWLER_API_KEY is not set" >&2
  exit 1
fi

if [[ -n "$HTML_FILE" ]]; then
  PAYLOAD=$(jq -n \
    --arg url "$URL" \
    --rawfile html "$HTML_FILE" \
    --argjson preview "$PREVIEW" \
    '{url: $url, mode: "direct", preview: $preview, html: $html}')
  echo "Crawling URL: $URL"
  echo "HTML source:  $HTML_FILE"
else
  PAYLOAD=$(jq -n \
    --arg url "$URL" \
    --argjson preview "$PREVIEW" \
    '{url: $url, mode: "direct", preview: $preview}')
  echo "Crawling URL: $URL"
  echo "HTML source:  live fetch"
fi

echo "Mode: $([ "$PREVIEW" = "true" ] && echo "preview (not publishing)" || echo "publish")"
echo ""

curl -s -X POST "${CRAWLER_WORKER_URL}/crawl" \
  -H "Authorization: Bearer ${CRAWLER_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" | jq .
