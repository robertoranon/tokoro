#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/restore-from-backup.sh <backup-file.json>
# Restores events from a JSON backup file (produced by the Worker R2 backup)
# into the D1 database using wrangler d1 execute.
#
# WARNING: This inserts rows — it does NOT clear the table first.
# Run manually: wrangler d1 execute happenings-db --command "DELETE FROM events"
# before restoring if you want a clean slate.

if [ $# -lt 1 ]; then
	echo "Usage: $0 <backup-file.json>"
	exit 1
fi

BACKUP_FILE="$1"
DB_NAME="happenings-db"

if [ ! -f "$BACKUP_FILE" ]; then
	echo "Error: file not found: $BACKUP_FILE"
	exit 1
fi

echo "Generating INSERT statements from $BACKUP_FILE ..."

# Extract events array and generate INSERT SQL using node
SQL_FILE=$(mktemp /tmp/happenings-restore-XXXXXX.sql)

node - "$BACKUP_FILE" "$SQL_FILE" <<'EOF'
const fs = require('fs');
const [,, inputFile, outputFile] = process.argv;
const { tables } = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const events = tables.events || [];

const stmts = events.map(e => {
  const fields = Object.keys(e);
  const values = fields.map(f => {
    const v = e[f];
    if (v === null || v === undefined) return 'NULL';
    return "'" + String(v).replace(/'/g, "''") + "'";
  });
  return `INSERT OR IGNORE INTO events (${fields.join(', ')}) VALUES (${values.join(', ')});`;
});

fs.writeFileSync(outputFile, stmts.join('\n') + '\n');
console.log(`Generated ${stmts.length} INSERT statements.`);
EOF

cd "$(dirname "$0")/../worker"
echo "Executing SQL against $DB_NAME ..."
npx wrangler d1 execute "$DB_NAME" --file "$SQL_FILE"
rm "$SQL_FILE"
echo "Restore complete."
