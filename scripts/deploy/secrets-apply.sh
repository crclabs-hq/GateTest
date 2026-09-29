#!/usr/bin/env bash
# secrets-apply.sh — run by gatetest-secrets-apply.service (a .path unit
# watches /var/lib/gatetest/unit-env/platform.env). The admin secrets panel
# (docs/ops/secrets-panel.md) only WRITES that file; this is what makes the
# running site pick it up: the existing zero-downtime blue/green restart
# (blue-green-restart.sh), so the web process never restarts itself and
# never needs sudo.
#
# Two things differ from a deploy:
#   - It takes pull-deploy's flock first (waiting up to 30 min), so a secrets
#     apply and a deploy never restart instances at the same time.
#   - No new code is being shipped, so the commit the new instance must report
#     is the one the ACTIVE instance reports now — not `git rev-parse HEAD`,
#     which can be ahead of the build if a pull-deploy failed mid-way.
#
# Prints no environment and no value — only ports, commits and the outcome.
set -euo pipefail

APP_DIR="${GATETEST_APP_DIR:-/opt/gatetest}"
LOCK_FILE="${PULL_DEPLOY_LOCK:-/var/lock/gatetest-pull-deploy.lock}"
HOST="${GATETEST_WEB_HOST:-10.0.1.1}"
ACTIVE_PORT_FILE="${PULL_DEPLOY_ACTIVE_PORT_FILE:-/var/lib/gatetest/pull-deploy-active-port}"

mkdir -p "$(dirname "$LOCK_FILE")"
exec 200>"$LOCK_FILE"
if ! flock -w 1800 200; then
  echo "[secrets-apply] another deploy held $LOCK_FILE for 30 min — not restarting; the next write of platform.env retries" >&2
  exit 1
fi

if [ -z "${PULL_DEPLOY_EXPECTED_COMMIT:-}" ] && [ -r "$ACTIVE_PORT_FILE" ]; then
  ACTIVE_PORT="$(cat "$ACTIVE_PORT_FILE")"
  # No answer from the active instance is not fatal: blue-green-restart.sh
  # then falls back to git HEAD and logs which commit it expects.
  if BODY="$(curl -s -m 5 "http://${HOST}:${ACTIVE_PORT}/api/platform-status")"; then
    COMMIT="$(printf '%s' "$BODY" | sed -n 's/.*"commit":"\([0-9a-f]\{7,40\}\)".*/\1/p' | head -n 1)"
    if [ -n "$COMMIT" ]; then
      export PULL_DEPLOY_EXPECTED_COMMIT="$COMMIT"
    fi
  else
    echo "[secrets-apply] active instance on port $ACTIVE_PORT did not answer — expecting git HEAD" >&2
  fi
fi

echo "[secrets-apply] platform.env changed — blue/green restart (expected commit ${PULL_DEPLOY_EXPECTED_COMMIT:-HEAD})"
# exec keeps fd 200 (the lock) open for the whole restart.
exec /bin/bash "$APP_DIR/scripts/deploy/blue-green-restart.sh"
