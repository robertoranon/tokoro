#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/backup-local.sh [output-dir]
# Produces a full SQL dump of the D1 database locally using wrangler.

DB_NAME="happenings-db"
OUTPUT_DIR="${1:-.}"
DATE=$(date +%Y-%m-%d)
OUTPUT_FILE="$OUTPUT_DIR/backup-$DATE.sql"

mkdir -p "$OUTPUT_DIR"

echo "Exporting D1 database '$DB_NAME' to $OUTPUT_FILE ..."
cd "$(dirname "$0")/../worker"
npx wrangler d1 export "$DB_NAME" --output "$OUTPUT_FILE"
echo "Done: $OUTPUT_FILE"
