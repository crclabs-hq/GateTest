#!/usr/bin/env bash
# Close the code-scanning alerts stranded in RETIRED categories (Known Issue #105).
#
# Before PR #422 the two SARIF uploads used the categories
#   .github/workflows/ci.yml:gatetest   and   .github/workflows/ci.yml:gatetest-full
# Both were then unified under `gatetest`. GitHub only auto-closes an alert when a
# NEWER analysis in the SAME category no longer contains it — and nothing uploads
# to the old categories any more, so their alerts (519 on 2026-09-13: 475 + 44)
# stay open forever and the Security tab reads 1,423 instead of 904.
#
# The only fix GitHub offers is deleting the old categories' analyses:
#   DELETE /repos/{owner}/{repo}/code-scanning/analyses/{id}?confirm_delete
# Only the newest analysis in a set is `deletable`; deleting it makes the next one
# deletable, so we loop. Needs `gh auth login` as a repo admin (Craig).
#
# Usage:  bash scripts/ops/close-retired-code-scanning-categories.sh [owner/repo]
set -euo pipefail
REPO="${1:-crclabs-hq/GateTest}"
deleted=0
for round in $(seq 1 80); do
  ids="$(gh api "repos/$REPO/code-scanning/analyses?per_page=100" --paginate \
        --jq '.[] | select(.category != "gatetest" and .deletable == true) | .id')"
  [ -z "$ids" ] && break
  for id in $ids; do
    if gh api -X DELETE "repos/$REPO/code-scanning/analyses/$id?confirm_delete" >/dev/null; then
      deleted=$((deleted + 1))
    else
      echo "delete $id failed" >&2
    fi
  done
  echo "round $round: deleted so far $deleted"
done
echo "done: deleted $deleted analyses"
echo "remaining analyses in retired categories:"
if ! gh api "repos/$REPO/code-scanning/analyses?per_page=100" --paginate \
  --jq '.[] | select(.category != "gatetest") | .category' | sort | uniq -c; then
  echo "  (could not list remaining analyses — re-run the script to check)" >&2
fi
echo "open alerts by category now:"
gh api "repos/$REPO/code-scanning/alerts?state=open&per_page=100" --paginate \
  --jq '.[] | .most_recent_instance.category' | sort | uniq -c
