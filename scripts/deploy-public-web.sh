#!/usr/bin/env bash
# deploy-public-web.sh — Build and deploy public-web to Cloudflare Pages.
#
# Injects real URLs into index.html and it.html from config.local.js,
# deploys to Cloudflare Pages, then restores the source files to their
# placeholder state so the repo stays clean.
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

# Ensure we can restore the HTML files via git
if ! git -C "${REPO_ROOT}" diff --quiet HEAD -- public-web/index.html public-web/it.html; then
  echo "Error: public-web/index.html or it.html has uncommitted changes." >&2
  echo "Commit or stash them before deploying." >&2
  exit 1
fi

cleanup() {
  echo "Restoring source HTML files..."
  git -C "${REPO_ROOT}" checkout -- public-web/index.html public-web/it.html
  echo "Source files restored."
}
trap cleanup EXIT

echo "Building bookmarklet and injecting URLs..."
node "${PUBLIC_WEB}/build-bookmarklet.js"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] Would deploy public-web to Cloudflare Pages (project: happenings-query)"
  echo "[dry-run] Skipping deploy."
else
  echo "Deploying to Cloudflare Pages..."
  npx wrangler pages deploy "${PUBLIC_WEB}" --project-name happenings-query
fi
