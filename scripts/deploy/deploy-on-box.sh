#!/usr/bin/env bash
# deploy-on-box.sh — run ON the production box (66.42.121.161) to bring the
# live site up to date with origin/main. Idempotent; safe to re-run.
#
# Called two ways:
#   1. Manually over SSH:      bash scripts/deploy/deploy-on-box.sh
#   2. By the deploy-box.yml GitHub Action on every push to main.
#
# Environment (set on the box, optional):
#   GATETEST_APP_DIR      — repo checkout path   (default: the repo this script lives in)
#   GATETEST_RESTART_CMD  — restart command      (default: auto-detect pm2 'gatetest',
#                           then systemd 'gatetest', else warn and skip)
set -euo pipefail

APP_DIR="${GATETEST_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$APP_DIR"

echo "[deploy] $(date -u +%FT%TZ) — deploying $(git rev-parse --abbrev-ref HEAD) in $APP_DIR"

# Refuse to clobber uncommitted changes on the box — a box should never have any.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[deploy] ERROR: uncommitted changes on the box — resolve manually first." >&2
  git status --short >&2
  exit 1
fi

BEFORE=$(git rev-parse HEAD)
git fetch origin main
git reset --hard origin/main
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  echo "[deploy] already at $AFTER — nothing to do (use --force-build to rebuild anyway)"
  [ "${1:-}" = "--force-build" ] || exit 0
fi

echo "[deploy] $BEFORE -> $AFTER"
npm install --no-audit --no-fund
(cd website && npm install --no-audit --no-fund && npx next build)

# Restart the service.
if [ -n "${GATETEST_RESTART_CMD:-}" ]; then
  echo "[deploy] restarting via GATETEST_RESTART_CMD"
  bash -c "$GATETEST_RESTART_CMD"
elif command -v pm2 >/dev/null 2>&1 && pm2 describe gatetest >/dev/null 2>&1; then
  echo "[deploy] restarting pm2 process 'gatetest'"
  pm2 restart gatetest --update-env
elif systemctl list-unit-files 2>/dev/null | grep -q '^gatetest\.service'; then
  echo "[deploy] restarting systemd unit 'gatetest'"
  sudo systemctl restart gatetest
else
  echo "[deploy] WARNING: no restart mechanism found (set GATETEST_RESTART_CMD) — build is in place but the old process is still serving." >&2
fi

# Post-deploy smoke: the endpoints that burned us when the box served a stale build.
sleep 3
for probe in "https://gatetest.ai/api/status" "https://gatetest.ai/icon.png"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$probe" || echo 000)
  echo "[deploy] smoke $probe -> $code"
done
echo "[deploy] done — verify /api/status shows ready:true"
