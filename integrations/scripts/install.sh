#!/usr/bin/env bash
# ============================================================================
# GATETEST INTEGRATION INSTALLER — PROTECTED FILE
# ============================================================================
# Drops the full GateTest quality gate into a target repository.
# Run this from the ROOT of the repo you want to protect.
#
#   curl -sSL https://raw.githubusercontent.com/crclabs-hq/gatetest/main/integrations/scripts/install.sh | bash
#
# Or, locally:
#   bash /path/to/gatetest/integrations/scripts/install.sh
#
# What it installs:
#   1. .github/workflows/gatetest-gate.yml   — CI quality gate
#   2. .husky/pre-push                        — local pre-push hook
#   3. .gatetest.json                         — protection marker
#
# See CLAUDE.md → "PROTECTED PLATFORMS" in the GateTest Bible.
# ============================================================================
set -euo pipefail

GATETEST_REPO="${GATETEST_REPO:-https://github.com/crclabs-hq/gatetest.git}"
GATETEST_RAW="${GATETEST_RAW:-https://raw.githubusercontent.com/crclabs-hq/gatetest/main}"
TARGET="${TARGET:-$(pwd)}"

if [ ! -d "$TARGET/.git" ]; then
  echo "[GateTest] ERROR: $TARGET is not a git repository." >&2
  exit 1
fi

echo "[GateTest] Installing protection layer into: $TARGET"

# 1. GitHub Actions workflow
mkdir -p "$TARGET/.github/workflows"
curl -sSL "$GATETEST_RAW/integrations/github-actions/gatetest-gate.yml" \
  -o "$TARGET/.github/workflows/gatetest-gate.yml"
echo "  ✓ .github/workflows/gatetest-gate.yml"

# 2. Pre-push hook
mkdir -p "$TARGET/.husky"
curl -sSL "$GATETEST_RAW/integrations/husky/pre-push" \
  -o "$TARGET/.husky/pre-push"
chmod +x "$TARGET/.husky/pre-push"
echo "  ✓ .husky/pre-push (executable)"

# 3. Protection marker — tells any future Claude session this repo is protected
cat > "$TARGET/.gatetest.json" <<'JSON'
{
  "protected": true,
  "gatetest_source": "https://github.com/crclabs-hq/gatetest",
  "do_not_remove": "This repo is protected by GateTest. See .github/workflows/gatetest-gate.yml and .husky/pre-push. Removing either breaks the quality gate. Requires Craig authorization.",
  "integration_version": 1
}
JSON
echo "  ✓ .gatetest.json (protection marker)"

echo
echo "[GateTest] ✓ Installation complete."
echo
echo "Next steps:"
echo "  1. Enable Husky:   npx husky init  (once per repo)"
echo "  2. Commit:         git add .github .husky .gatetest.json && git commit -m 'chore: install GateTest quality gate'"
echo "  3. Push:           git push"
echo
echo "On the next push or PR, GateTest will run the full quality gate."
echo
echo "AUTO-REPAIR is ON BY DEFAULT when ANTHROPIC_API_KEY is available:"
echo "  • Failing runs automatically open a 'gatetest/auto-repair-<run-id>'"
echo "    PR with Claude-generated fixes. The original PR stays untouched."
echo "  • To set the secret ONCE for ALL repos in your org:"
echo "      https://github.com/organizations/<your-org>/settings/secrets/actions"
echo "      → New organization secret → ANTHROPIC_API_KEY → All repositories"
echo "  • To DISABLE auto-repair for THIS repo:"
echo "      Settings → Secrets and variables → Actions → Variables tab"
echo "      → New repository variable → GATETEST_AUTOFIX = off"
