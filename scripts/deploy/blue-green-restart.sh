#!/usr/bin/env bash
# blue-green-restart.sh — zero-downtime restart hook for pull-deploy.sh
# (issue #663; see docs/deploy/PULL-DEPLOY.md "Blue/green").
#
# deploy-on-box.sh already supports a restart override, GATETEST_RESTART_CMD
# ("if -n GATETEST_RESTART_CMD; bash -c $GATETEST_RESTART_CMD"). pull-deploy.sh
# points that at this script, so this file's only job starts after the new
# build is on disk and `npm run build` has already stamped the new commit
# into build-info.json: get public traffic onto it without the old process
# ever having nothing to answer to (the 502s issue #663 reports).
#
# Why this is not a Caddy/nginx script: CLAUDE.md's Deployment Doctrine
# (2026-09-11) bans configuring Caddy, nginx, or "every other proxy" on this
# box — the front door is Tallrig's own `tallrig-bun-gateway`, and its config
# lives on the Tallrig side, not in this repo. So the actual proxy-switch
# step is delegated to a pluggable external command
# (PULL_DEPLOY_PROXY_SWITCH_CMD, default scripts/deploy/switch-proxy.sh) that
# the box operator supplies for whatever mechanism the real front door
# exposes. Until that command is wired up, switch-proxy.sh refuses on
# purpose (Bible Doctrine #1: never report success while doing nothing) and
# this script aborts SAFELY — the old instance is left serving, exit
# non-zero — rather than silently leaving two instances up with no traffic
# switched.
#
# Environment (all optional):
#   GATETEST_APP_DIR              repo checkout               (default: /opt/gatetest)
#   PULL_DEPLOY_INPLACE           1 = skip blue/green entirely, restart one
#                                 fixed unit like the old behaviour (for a
#                                 box with only one port free)
#   PULL_DEPLOY_INPLACE_UNIT      the fixed unit for INPLACE mode (default: gatetest-web)
#   PULL_DEPLOY_EXPECTED_COMMIT   commit the new instance must report; pull-deploy.sh
#                                 passes the commit it just deployed
#                                 (default: `git -C APP_DIR rev-parse HEAD`)
#   GATETEST_WEB_HOST             bind host both instances listen on          (default: 10.0.1.1)
#   GATETEST_WEB_PORT_A/_B        the two blue/green ports                    (default: 3000 / 3001)
#   PULL_DEPLOY_WEB_UNIT_TEMPLATE systemd template unit prefix                (default: gatetest-web@)
#   PULL_DEPLOY_ACTIVE_PORT_FILE  remembers which port is currently live      (default: /var/lib/gatetest/pull-deploy-active-port)
#   PULL_DEPLOY_HEALTH_TIMEOUT_S  seconds to wait for the new instance        (default: 120)
#   PULL_DEPLOY_HEALTH_INTERVAL_S poll interval while waiting                 (default: 2)
#   PULL_DEPLOY_PROXY_SWITCH_CMD  command to flip the real front door,
#                                 invoked as "$CMD <new-port>"                (default: $APP_DIR/scripts/deploy/switch-proxy.sh)
#   PULL_DEPLOY_SMOKE_URL         public URL polled after the switch          (default: https://gatetest.io/api/platform-status)
#   PULL_DEPLOY_SMOKE_DURATION_S  how many 1-second polls                     (default: 30)
#   PULL_DEPLOY_SMOKE_INTERVAL_S  seconds between polls                       (default: 1)
set -euo pipefail

APP_DIR="${GATETEST_APP_DIR:-/opt/gatetest}"

log() { echo "[blue-green] $*"; }
err() { echo "[blue-green] ERROR: $*" >&2; }

# ---------------------------------------------------------------------------
# In-place fallback — PULL_DEPLOY_INPLACE=1, for a box with only one port
# free. Exactly the old pull-deploy behaviour: restart one fixed unit.
# ---------------------------------------------------------------------------
if [ "${PULL_DEPLOY_INPLACE:-0}" = "1" ]; then
  UNIT="${PULL_DEPLOY_INPLACE_UNIT:-gatetest-web}"
  log "PULL_DEPLOY_INPLACE=1 — restarting '$UNIT' in place (brief 502s expected)"
  systemctl restart "$UNIT"
  exit $?
fi

HOST="${GATETEST_WEB_HOST:-10.0.1.1}"
PORT_A="${GATETEST_WEB_PORT_A:-3000}"
PORT_B="${GATETEST_WEB_PORT_B:-3001}"
UNIT_TEMPLATE="${PULL_DEPLOY_WEB_UNIT_TEMPLATE:-gatetest-web@}"
ACTIVE_PORT_FILE="${PULL_DEPLOY_ACTIVE_PORT_FILE:-/var/lib/gatetest/pull-deploy-active-port}"
HEALTH_TIMEOUT_S="${PULL_DEPLOY_HEALTH_TIMEOUT_S:-120}"
HEALTH_INTERVAL_S="${PULL_DEPLOY_HEALTH_INTERVAL_S:-2}"
SWITCH_CMD="${PULL_DEPLOY_PROXY_SWITCH_CMD:-$APP_DIR/scripts/deploy/switch-proxy.sh}"
SMOKE_URL="${PULL_DEPLOY_SMOKE_URL:-https://gatetest.io/api/platform-status}"
SMOKE_DURATION_S="${PULL_DEPLOY_SMOKE_DURATION_S:-30}"
SMOKE_INTERVAL_S="${PULL_DEPLOY_SMOKE_INTERVAL_S:-1}"

EXPECTED_COMMIT="${PULL_DEPLOY_EXPECTED_COMMIT:-}"
if [ -z "$EXPECTED_COMMIT" ]; then
  EXPECTED_COMMIT="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
fi

# --- which port is live today? Default to A on first-ever run (bootstrap is
# --- a documented manual step — see docs/deploy/PULL-DEPLOY.md "Blue/green").
mkdir -p "$(dirname "$ACTIVE_PORT_FILE")" 2>/dev/null || true
ACTIVE_PORT="$PORT_A"
if [ -r "$ACTIVE_PORT_FILE" ]; then
  READ_PORT="$(cat "$ACTIVE_PORT_FILE" 2>/dev/null || true)"
  if [ "$READ_PORT" = "$PORT_A" ] || [ "$READ_PORT" = "$PORT_B" ]; then
    ACTIVE_PORT="$READ_PORT"
  fi
fi
if [ "$ACTIVE_PORT" = "$PORT_A" ]; then
  NEW_PORT="$PORT_B"
else
  NEW_PORT="$PORT_A"
fi

NEW_UNIT="${UNIT_TEMPLATE}${NEW_PORT}.service"
ACTIVE_UNIT="${UNIT_TEMPLATE}${ACTIVE_PORT}.service"

log "active=$ACTIVE_UNIT new=$NEW_UNIT expected commit=$EXPECTED_COMMIT"

cleanup_new() {
  systemctl stop "$NEW_UNIT" >/dev/null 2>&1 || true
}

log "starting $NEW_UNIT"
if ! systemctl start "$NEW_UNIT"; then
  err "systemctl start $NEW_UNIT failed — aborting, $ACTIVE_UNIT stays live"
  exit 1
fi

# --- poll the new instance directly (localhost, bypassing the proxy) until
# --- it answers with the NEW commit, or time out. ---
DEADLINE=$((SECONDS + HEALTH_TIMEOUT_S))
HEALTHY=0
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  BODY="$(curl -s -m 5 "http://${HOST}:${NEW_PORT}/api/platform-status" 2>/dev/null || true)"
  case "$BODY" in
    *"\"commit\":\"${EXPECTED_COMMIT}\""*)
      HEALTHY=1
      break
      ;;
  esac
  sleep "$HEALTH_INTERVAL_S"
done

if [ "$HEALTHY" -ne 1 ]; then
  err "new instance on port $NEW_PORT never answered /api/platform-status with commit $EXPECTED_COMMIT within ${HEALTH_TIMEOUT_S}s — aborting, $ACTIVE_UNIT stays live"
  cleanup_new
  exit 1
fi
log "$NEW_UNIT is healthy at commit $EXPECTED_COMMIT"

# --- switch the reverse proxy upstream to the new port. ---
if ! "$SWITCH_CMD" "$NEW_PORT"; then
  err "proxy switch command failed ($SWITCH_CMD $NEW_PORT) — aborting, $ACTIVE_UNIT stays live, traffic never moved"
  cleanup_new
  exit 1
fi
log "proxy switched to port $NEW_PORT"

# --- old instance can go now that nothing points at it. ---
if ! systemctl stop "$ACTIVE_UNIT"; then
  log "WARNING: systemctl stop $ACTIVE_UNIT reported an error (non-fatal — new instance is already live and serving)"
fi
if ! printf '%s' "$NEW_PORT" > "$ACTIVE_PORT_FILE" 2>/dev/null; then
  log "WARNING: could not record active port in $ACTIVE_PORT_FILE — next deploy will re-derive it and may restart the wrong instance first"
fi
log "$ACTIVE_UNIT stopped; active port is now $NEW_PORT"

# --- smoke test: poll the PUBLIC endpoint (through the proxy) every second
# --- for SMOKE_DURATION_S. Any non-200 fails loudly and immediately — the
# --- switch already happened, but a silent failure here is exactly the
# --- "reports success while doing nothing" bug the Bible calls out. ---
i=0
while [ "$i" -lt "$SMOKE_DURATION_S" ]; do
  CODE="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$SMOKE_URL" 2>/dev/null || echo 000)"
  if [ "$CODE" != "200" ]; then
    err "post-switch smoke: $SMOKE_URL returned HTTP $CODE at check $((i + 1))/$SMOKE_DURATION_S — exiting non-zero"
    exit 1
  fi
  i=$((i + 1))
  sleep "$SMOKE_INTERVAL_S"
done

log "post-switch smoke clean for ${SMOKE_DURATION_S}s — deploy complete on port $NEW_PORT"
exit 0
