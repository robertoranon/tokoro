#!/usr/bin/env bash
# deploy-public-web.sh — Build and deploy public-web to Cloudflare Pages.
#
# Injects real URLs into a temp copy of public-web so the source tree stays
# clean (no uncommitted changes during deployment).
#
# Usage: ./scripts/deploy-public-web.sh [--dry-run]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PUBLIC_WEB="${REPO_ROOT}/public-web"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# Verify config exists
if [[ ! -f "${REPO_ROOT}/config.local.js" ]]; then
  echo "Error: config.local.js not found." >&2
  echo "Copy config.local.js.example to config.local.js and fill in your values." >&2
  exit 1
fi

DEPLOY_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${DEPLOY_DIR}"
}
trap cleanup EXIT

WORKER_URL="$(node -e "console.log(require('${REPO_ROOT}/config.local.js').workerUrl)")"
if [[ -z "$WORKER_URL" ]]; then
  echo "Error: could not read workerUrl from config.local.js." >&2
  exit 1
fi

CRAWLER_URL="$(node -e "console.log(require('${REPO_ROOT}/config.local.js').crawlerWorkerUrl || '')")"
RELAY_URL="$(node -e "console.log(require('${REPO_ROOT}/config.local.js').relayUrl || '')")"

echo "Building bookmarklet..."
node "${PUBLIC_WEB}/build-bookmarklet.js"

echo "Copying public-web to temp directory..."
cp -r "${PUBLIC_WEB}/." "${DEPLOY_DIR}/"

echo "Injecting URLs into temp copy..."
node "${PUBLIC_WEB}/inject-worker-url.js" "$WORKER_URL" "$CRAWLER_URL" "$RELAY_URL" "${DEPLOY_DIR}"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] Would deploy public-web to Cloudflare Pages (project: tokoro-query)"
  echo "[dry-run] Skipping deploy."
else
  echo "Deploying to Cloudflare Pages..."
  npx wrangler pages deploy "${DEPLOY_DIR}" --project-name tokoro-query
fi
