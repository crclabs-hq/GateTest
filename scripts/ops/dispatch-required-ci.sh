#!/usr/bin/env bash
# GitHub does not start `pull_request` workflows for events created with
# secrets.GITHUB_TOKEN, so a bot-opened/updated PR's required checks never
# report and the PR sits BLOCKED forever (2026-09-19; done by hand for
# #609/#610). `workflow_dispatch` is GitHub's documented exception — it DOES
# start workflows even when triggered via GITHUB_TOKEN, and a
# workflow_dispatch run on branch X attaches its check runs to X's head
# commit with the same job names ci.yml uses on pull_request, which is what
# required status checks match on. This is the one place (Doctrine #4) that
# fires that dispatch — call it from every bot workflow right after it
# pushes/updates its PR branch.
#
# Usage: bash scripts/ops/dispatch-required-ci.sh <branch>
set -euo pipefail

BRANCH="${1:?usage: dispatch-required-ci.sh <branch>}"

if ! gh workflow run ci.yml --ref "$BRANCH"; then
  echo "::warning::dispatch-required-ci: 'gh workflow run ci.yml --ref $BRANCH' failed — the PR still exists, but its required checks (Test + Build, Pre-Merge Sweep, GateTest Quality Gate, GateTest Full Scan) will not report until someone re-runs it by hand from the Actions tab (CI > Run workflow, ref: $BRANCH)."
  exit 0
fi

echo "dispatched ci.yml on branch '$BRANCH'"
