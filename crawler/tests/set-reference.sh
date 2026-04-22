#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."  # crawler/

LATEST=$(ls tests/snapshots/report-*.json 2>/dev/null | sort | tail -1)
if [ -z "$LATEST" ]; then
  echo "No test reports found. Run 'npm run test' first."
  exit 1
fi

cp "$LATEST" tests/snapshots/reference.json
echo "Reference updated from: $LATEST"
echo ""
echo "Don't forget to commit:"
echo "  git add crawler/tests/snapshots/reference.json"
echo "  git commit -m \"test: update reference snapshot\""
