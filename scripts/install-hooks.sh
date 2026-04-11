#!/usr/bin/env bash
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

cat > "$HOOKS_DIR/pre-push" << 'HOOK'
#!/usr/bin/env bash
# Pre-push hook: runs crawler regression tests when shared/ files change.

REPO_ROOT="$(git rev-parse --show-toplevel)"
CRAWLER_DIR="$REPO_ROOT/crawler"
REFERENCE="$CRAWLER_DIR/tests/snapshots/reference.json"

# Read push info from stdin: <local-ref> <local-sha> <remote-ref> <remote-sha>
SHOULD_RUN=0
while read local_ref local_sha remote_ref remote_sha; do
  # Skip branch deletions
  if [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
    continue
  fi

  # Determine the range of commits being pushed
  if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
    # New branch: diff only the tip commit against merge-base with the upstream branch
    BASE=$(git merge-base "$local_sha" "origin/$(git symbolic-ref --short HEAD 2>/dev/null || echo main)" 2>/dev/null || echo "")
    if [ -n "$BASE" ]; then
      changed_files=$(git diff --name-only "$BASE" "$local_sha")
    else
      changed_files=$(git diff-tree --no-commit-id -r --name-only "$local_sha" 2>/dev/null || true)
    fi
  else
    changed_files=$(git diff --name-only "$remote_sha" "$local_sha")
  fi

  # Check if any changed file is under shared/
  if echo "$changed_files" | grep -q "^shared/"; then
    SHOULD_RUN=1
    break
  fi
done

if [ "$SHOULD_RUN" = "1" ]; then
  echo ""
  echo "🔍 shared/ changes detected — running crawler regression tests..."
  echo ""

  if [ ! -f "$REFERENCE" ]; then
    echo "⚠️  No reference.json found at $REFERENCE"
    echo "   Run: cd crawler && npm run test && npm run test:set-reference"
    echo "   Then commit crawler/tests/snapshots/reference.json"
    exit 1
  fi

  # Run tests
  cd "$CRAWLER_DIR"
  if ! npm run test; then
    echo ""
    echo "❌ Tests failed to run. Push blocked."
    exit 1
  fi

  # Find the new report
  LATEST=$(ls tests/snapshots/report-*.json 2>/dev/null | sort | tail -1)
  if [ -z "$LATEST" ]; then
    echo "❌ No test report generated. Push blocked."
    exit 1
  fi

  # Compare against reference (exits 1 if regressions)
  echo ""
  echo "📊 Comparing against reference..."
  if npm run test:compare -- "tests/snapshots/reference.json" "$LATEST"; then
    # No regressions — check if overall recall improved
    IMPROVEMENTS=$(node -e "
      const b = JSON.parse(require('fs').readFileSync('tests/snapshots/reference.json','utf8'));
      const c = JSON.parse(require('fs').readFileSync('$LATEST','utf8'));
      const bAvg = b.results.reduce((s,r)=>s+r.metrics.recall,0)/b.results.length;
      const cAvg = c.results.reduce((s,r)=>s+r.metrics.recall,0)/c.results.length;
      console.log(cAvg > bAvg ? 'yes' : 'no');
    " 2>/dev/null || echo "no")

    if [ "$IMPROVEMENTS" = "yes" ]; then
      cp "$LATEST" tests/snapshots/reference.json
      echo ""
      echo "✅ Results improved — reference.json updated."
      echo "   Please commit: git add crawler/tests/snapshots/reference.json"
    else
      echo ""
      echo "✅ No regressions detected. Push proceeding."
    fi
    exit 0
  else
    echo ""
    echo "❌ Regressions detected. Push blocked."
    echo ""
    echo "Options:"
    echo "  1. Fix the regression, then: git push"
    echo "  2. Accept these results as new baseline: cd crawler && npm run test:set-reference"
    echo "     Then: git add crawler/tests/snapshots/reference.json && git commit && git push"
    echo "  3. Force push (skip tests): ./scripts/push-force.sh"
    exit 1
  fi
fi

exit 0
HOOK

chmod +x "$HOOKS_DIR/pre-push"
echo "✅ pre-push hook installed at $HOOKS_DIR/pre-push"
