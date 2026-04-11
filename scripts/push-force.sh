#!/usr/bin/env bash
# Force push bypassing pre-push hooks (skips regression tests).
# Usage: ./scripts/push-force.sh [git push args...]
git push --no-verify "$@"
