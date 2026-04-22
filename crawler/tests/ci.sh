#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."  # crawler/

echo "Running tests..."
if ! npm run test; then
  echo "Tests failed to run or reported errors."
  exit 1
fi

LATEST=$(ls tests/snapshots/report-*.json 2>/dev/null | sort | tail -1)
if [ -z "$LATEST" ]; then
  echo "No test report found after running tests."
  exit 1
fi

REFERENCE="tests/snapshots/reference.json"
if [ ! -f "$REFERENCE" ]; then
  echo "No reference.json found. Copy a report to $REFERENCE to establish a baseline."
  exit 1
fi

echo ""
echo "Comparing against reference..."
npm run test:compare -- "$REFERENCE" "$LATEST"
