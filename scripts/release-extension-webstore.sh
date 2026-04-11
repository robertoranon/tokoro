#!/usr/bin/env bash
set -euo pipefail

# Package Chrome extension as a zip for Chrome Web Store submission
# Usage: ./scripts/release-extension-webstore.sh [version]
#   version: optional, overrides manifest.json version (e.g. "1.3.0")

EXTENSION_DIR="chrome-extension"
MANIFEST="$EXTENSION_DIR/manifest.json"

CURRENT_VERSION=$(grep '"version"' "$MANIFEST" | sed 's/.*"version": "\(.*\)".*/\1/')

if [ "${1-}" != "" ]; then
  VERSION="$1"
else
  # Auto-increment the last version number
  VERSION=$(echo "$CURRENT_VERSION" | awk -F. '{$NF=$NF+1; print}' OFS='.')
fi

# Update version in manifest.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" "$MANIFEST"
echo "Updated manifest.json version: $CURRENT_VERSION -> $VERSION"

ZIP_NAME="happenings-extension-v$VERSION-webstore.zip"

DIST_DIR="happenings-chrome-extension"

echo "Packaging extension v$VERSION for Chrome Web Store..."

cp -r "$EXTENSION_DIR" "$DIST_DIR"

# Remove files not needed in the store package
rm -rf \
  "$DIST_DIR/node_modules" \
  "$DIST_DIR"/*.md \
  "$DIST_DIR"/package*.json

# Zip only the contents (not the wrapper directory) so Chrome Web Store
# sees manifest.json at the root of the archive
cd "$DIST_DIR"
zip -r "../$ZIP_NAME" .
cd ..
rm -rf "$DIST_DIR"

echo "Done: $ZIP_NAME"
echo "Upload this file at https://chrome.google.com/webstore/devconsole"
