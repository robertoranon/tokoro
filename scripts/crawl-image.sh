#!/usr/bin/env bash
# crawl-image.sh — Submit a local image to the remote crawler-worker for event extraction
#
# Usage: ./scripts/crawl-image.sh <image-path> [--publish]
#
# By default runs in preview mode (events are extracted but not published).
# Pass --publish to actually publish the extracted events.
#
# Required env vars:
#   CRAWLER_WORKER_URL  — e.g. https://happenings-crawler-worker.<subdomain>.workers.dev
#   CRAWLER_API_KEY     — API key for the crawler worker


# Load local configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/config.local.sh"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: ${CONFIG_FILE} not found. Copy scripts/config.local.sh.example to scripts/config.local.sh and fill in your values." >&2
  exit 1
fi
# shellcheck source=scripts/config.local.sh
source "$CONFIG_FILE"

set -euo pipefail

IMAGE_PATH="${1:-}"
PREVIEW=true

if [[ -z "$IMAGE_PATH" ]]; then
  echo "Usage: $0 <image-path> [--publish]" >&2
  exit 1
fi

if [[ ! -f "$IMAGE_PATH" ]]; then
  echo "Error: file not found: $IMAGE_PATH" >&2
  exit 1
fi

for arg in "${@:2}"; do
  case "$arg" in
    --publish) PREVIEW=false ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [[ -z "${CRAWLER_WORKER_URL:-}" ]]; then
  echo "Error: CRAWLER_WORKER_URL is not set" >&2
  exit 1
fi

if [[ -z "${CRAWLER_API_KEY:-}" ]]; then
  echo "Error: CRAWLER_API_KEY is not set" >&2
  exit 1
fi

# Detect MIME type from extension
EXT="${IMAGE_PATH##*.}"
case "$(echo "$EXT" | tr '[:upper:]' '[:lower:]')" in
  jpg|jpeg) MIME="image/jpeg" ;;
  png)      MIME="image/png" ;;
  gif)      MIME="image/gif" ;;
  webp)     MIME="image/webp" ;;
  *)        MIME="image/jpeg" ;;
esac

# Make up a plausible URL from the filename
FILENAME=$(basename "$IMAGE_PATH")
FAKE_URL="https://happenings.local/images/${FILENAME}"

IMAGE_B64=$(base64 -i "$IMAGE_PATH")

PAYLOAD=$(jq -n \
  --arg url "$FAKE_URL" \
  --arg imageData "$IMAGE_B64" \
  --arg imageMimeType "$MIME" \
  --argjson preview "$PREVIEW" \
  '{url: $url, mode: "image", imageData: $imageData, imageMimeType: $imageMimeType, preview: $preview}')

echo "Crawling image: $IMAGE_PATH"
echo "Mode: $([ "$PREVIEW" = "true" ] && echo "preview (not publishing)" || echo "publish")"
echo ""

curl -s -X POST "${CRAWLER_WORKER_URL}/crawl" \
  -H "Authorization: Bearer ${CRAWLER_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" | jq .
