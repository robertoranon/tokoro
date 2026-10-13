#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/restore-from-backup.sh <backup-file.json>
# Restores events and the member tables (members, member_bands,
# band_suggestions) from a JSON backup file (produced by the Worker R2 backup)
# into the D1 database using wrangler d1 execute. Older backups that contain
# only events restore just the events.
#
# WARNING: This inserts rows — it does NOT clear the tables first.
# Run manually: wrangler d1 execute tokoro-db --command "DELETE FROM events"
# (and likewise for the member tables) before restoring if you want a clean slate.

if [ $# -lt 1 ]; then
	echo "Usage: $0 <backup-file.json>"
	exit 1
fi

BACKUP_FILE="$1"
DB_NAME="tokoro-db"

if [ ! -f "$BACKUP_FILE" ]; then
	echo "Error: file not found: $BACKUP_FILE"
	exit 1
fi

echo "Generating INSERT statements from $BACKUP_FILE ..."

# Extract the table arrays and generate INSERT SQL using node
SQL_FILE=$(mktemp /tmp/tokoro-restore-XXXXXX.sql)

node - "$BACKUP_FILE" "$SQL_FILE" <<'EOF'
const fs = require('fs');
const [,, inputFile, outputFile] = process.argv;
const { tables } = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const TABLES = ['events', 'members', 'member_bands', 'band_suggestions'];

const stmts = [];
for (const table of TABLES) {
  for (const e of tables[table] || []) {
    const fields = Object.keys(e);
    const values = fields.map(f => {
      const v = e[f];
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'number') return String(v);
      return "'" + String(v).replace(/'/g, "''") + "'";
    });
    stmts.push(
      `INSERT OR IGNORE INTO ${table} (${fields.join(', ')}) VALUES (${values.join(', ')});`
    );
  }
}

fs.writeFileSync(outputFile, stmts.join('\n') + '\n');
console.log(`Generated ${stmts.length} INSERT statements.`);
EOF

cd "$(dirname "$0")/../worker"
echo "Executing SQL against $DB_NAME ..."
npx wrangler d1 execute "$DB_NAME" --file "$SQL_FILE"
rm "$SQL_FILE"
echo "Restore complete."
