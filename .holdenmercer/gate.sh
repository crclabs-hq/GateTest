#!/usr/bin/env bash
# Holden Mercer custom gate for GateTest.
#
# The default Node gate in .github/workflows/holden-mercer-gate.yml only
# installs the root package.json — but our test suite require()s files in
# website/app/lib/ that depend on website-workspace packages (@babel/parser,
# @anthropic-ai/sdk, next, etc.) and on the vscode-extension workspace.
# Without the multi-workspace install, npm test crashes on first require()
# in 10-ish seconds. scripts/install-workspaces.sh is the canonical
# installer used by .github/workflows/ci.yml; reuse it here for parity.
set -euo pipefail

echo "::group::install workspaces (root + website + vscode-extension)"
bash scripts/install-workspaces.sh
echo "::endgroup::"

echo "::group::npm test"
npm test
echo "::endgroup::"
