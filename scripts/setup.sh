#!/usr/bin/env bash
# setup.sh — Sync config.local.js into dependent config files.
#
# Run this after editing config.local.js to propagate URLs and keys to:
#   crawler/.env  (TOKORO_API_URL)
#
# Usage: ./scripts/setup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_JS="${REPO_ROOT}/config.local.js"
CRAWLER_ENV="${REPO_ROOT}/crawler/.env"

if [[ ! -f "$CONFIG_JS" ]]; then
  echo "Error: config.local.js not found." >&2
  echo "Copy config.local.js.example to config.local.js and fill in your values." >&2
  exit 1
fi

WORKER_URL="$(node -e "console.log(require('${CONFIG_JS}').workerUrl)")"

if [[ -z "$WORKER_URL" || "$WORKER_URL" == "undefined" ]]; then
  echo "Error: could not read workerUrl from config.local.js." >&2
  exit 1
fi

if [[ ! -f "$CRAWLER_ENV" ]]; then
  echo "Error: crawler/.env not found." >&2
  echo "Copy crawler/.env.example to crawler/.env and fill in your LLM keys, then re-run this script." >&2
  exit 1
fi

TMP=$(mktemp)
if grep -q "^TOKORO_API_URL=" "$CRAWLER_ENV"; then
  sed "s|^TOKORO_API_URL=.*|TOKORO_API_URL=${WORKER_URL}|" "$CRAWLER_ENV" > "$TMP"
  mv "$TMP" "$CRAWLER_ENV"
  echo "Updated  crawler/.env  TOKORO_API_URL=${WORKER_URL}"
else
  rm "$TMP"
  echo "TOKORO_API_URL=${WORKER_URL}" >> "$CRAWLER_ENV"
  echo "Added    crawler/.env  TOKORO_API_URL=${WORKER_URL}"
fi

echo "Done."
