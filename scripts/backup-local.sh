#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/backup-local.sh [output-dir]
# Produces a full SQL dump of the remote (production) D1 database using wrangler.

DB_NAME="tokoro-db"
OUTPUT_DIR="${1:-.}"
DATE=$(date +%Y-%m-%d)

mkdir -p "$OUTPUT_DIR"
# Absolute path: the export runs from worker/, so a relative path would land there.
OUTPUT_FILE="$(cd "$OUTPUT_DIR" && pwd)/backup-$DATE.sql"

echo "Exporting D1 database '$DB_NAME' to $OUTPUT_FILE ..."
cd "$(dirname "$0")/../worker"
npx wrangler d1 export "$DB_NAME" --remote --output "$OUTPUT_FILE"
echo "Done: $OUTPUT_FILE"
