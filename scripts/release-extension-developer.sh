#!/usr/bin/env bash
set -euo pipefail

# Package Chrome extension as a zip for manual distribution
# Usage: ./scripts/release-extension.sh [version]
#   version: optional, overrides manifest.json version (e.g. "1.3.0")

EXTENSION_DIR="chrome-extension"
MANIFEST="$EXTENSION_DIR/manifest.json"

if [ "${1-}" != "" ]; then
  VERSION="$1"
else
  VERSION=$(grep '"version"' "$MANIFEST" | sed 's/.*"version": "\(.*\)".*/\1/')
fi

ZIP_NAME="happenings-extension-v$VERSION.zip"

DIST_DIR="happenings-chrome-extension"

echo "Packaging extension v$VERSION..."

cp -r "$EXTENSION_DIR" "$DIST_DIR"
rm -rf "$DIST_DIR/node_modules" "$DIST_DIR"/*.md "$DIST_DIR"/package*.json

zip -r "$ZIP_NAME" "$DIST_DIR/"
rm -rf "$DIST_DIR"

echo "Done: $ZIP_NAME"
echo "Upload this file to Google Drive, Dropbox, or any file host and share the download link."
