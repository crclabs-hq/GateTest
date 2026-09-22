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
# The real front door (CORRECTED 2026-09-22, read-only verification on box
# 161): Coolify's `coolify-proxy` (Traefik v3.6, file provider, reloads a
# watched dynamic-config file without dropping connections) — not Tallrig's
# `tallrig-bun-gateway`, which CLAUDE.md's Deployment Doctrine describes as
# the intended end state but which is not actually in front of gatetest.io
# yet. The proxy-switch step is still a pluggable external command
# (PULL_DEPLOY_PROXY_SWITCH_CMD, default scripts/deploy/switch-proxy.sh) —
# now a real implementation against Traefik's dynamic file, invoked as
# "$CMD <port> <expected-commit>" — rather than logic inlined here, so the
# box-specific mechanism stays swappable if the front door changes again.
# See docs/deploy/PULL-DEPLOY.md "Blue/green" for the full story.
#
# Rollback: switch-proxy.sh now restores the dynamic file's pre-switch bytes
# itself on a failed receipt (platform-team review of 338242e4, 2026-09-22)
# — the pointer never rests on a target that never answered, even if THIS
# script dies right after switch-proxy.sh exits (OOM, SSH drop, Ctrl-C).
# This script still calls the same switch command again with the OLD port
# and the commit the old instance was reporting before the deploy started,
# belt and braces: since the file is already back to that state, the call
# is a same-content rewrite that verifies immediately and must not itself
# be treated as a failure just because there was nothing left to fix. Then
# it stops the (unhealthy-for-this-purpose) new instance and exits
# non-zero. The old instance is never stopped until the NEW switch has been
# verified, so there is always something for either restore path to point
# back at.
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
#                                 invoked as "$CMD <port> <expected-commit>"  (default: $APP_DIR/scripts/deploy/switch-proxy.sh)
#   PULL_DEPLOY_PUBLIC_HOST       public hostname, used for the final smoke  (default: gatetest.io)
#   PULL_DEPLOY_SMOKE_URL         public URL polled after the switch          (default: https://<PUBLIC_HOST>/api/platform-status)
#   PULL_DEPLOY_SMOKE_DURATION_S  how many 1-second polls                     (default: 30)
#   PULL_DEPLOY_SMOKE_INTERVAL_S  seconds between polls                       (default: 1)
set -euo pipefail

APP_DIR="${GATETEST_APP_DIR:-/opt/gatetest}"

log() { echo "[blue-green] $*"; }
err() { echo "[blue-green] ERROR: $*" >&2; }

extract_commit() {
  # $1 = a /api/platform-status response body
  printf '%s' "$1" | grep -o '"commit":"[^"]*"' | head -n1 | cut -d'"' -f4
}

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
PUBLIC_HOST="${PULL_DEPLOY_PUBLIC_HOST:-gatetest.io}"
SMOKE_URL="${PULL_DEPLOY_SMOKE_URL:-https://${PUBLIC_HOST}/api/platform-status}"
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

# --- learn what the currently-active instance reports, so a failed switch ---
# --- can roll back to a commit switch-proxy.sh can actually verify. Best ---
# --- effort: on the very first-ever bootstrap the active instance may not ---
# --- be running the templated unit yet (see docs "Blue/green" migration), ---
# --- in which case rollback verification just can't match and the ---
# --- operator sees that plainly in the log rather than a silent no-op. ---
PREV_BODY="$(curl -s -m 5 "http://${HOST}:${ACTIVE_PORT}/api/platform-status" 2>/dev/null || true)"
PREV_COMMIT="$(extract_commit "$PREV_BODY")"
if [ -z "$PREV_COMMIT" ]; then
  log "WARNING: could not determine the commit currently served on port $ACTIVE_PORT — a rollback, if needed, will not verify"
  PREV_COMMIT="unknown"
fi

log "active=$ACTIVE_UNIT (commit $PREV_COMMIT) new=$NEW_UNIT expected commit=$EXPECTED_COMMIT"

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

# --- switch the reverse proxy upstream to the new port, verified through ---
# --- the real public front door. The old instance is deliberately still ---
# --- running at this point, so a failed switch can roll back to it. ---
if ! "$SWITCH_CMD" "$NEW_PORT" "$EXPECTED_COMMIT"; then
  err "proxy switch to port $NEW_PORT failed ($SWITCH_CMD) — it should have already restored itself; confirming rollback to $ACTIVE_UNIT (port $ACTIVE_PORT, commit $PREV_COMMIT)"
  if "$SWITCH_CMD" "$ACTIVE_PORT" "$PREV_COMMIT"; then
    log "rollback to port $ACTIVE_PORT confirmed"
  else
    err "rollback confirmation to port $ACTIVE_PORT ALSO failed — check $ACTIVE_UNIT and the proxy dynamic file by hand"
  fi
  cleanup_new
  exit 1
fi
log "proxy switched to port $NEW_PORT (verified through $PUBLIC_HOST)"

# --- old instance can go now that the real front door verifiably serves ---
# --- the new one. ---
if ! systemctl stop "$ACTIVE_UNIT"; then
  log "WARNING: systemctl stop $ACTIVE_UNIT reported an error (non-fatal — new instance is already live and serving)"
fi
if ! printf '%s' "$NEW_PORT" > "$ACTIVE_PORT_FILE" 2>/dev/null; then
  log "WARNING: could not record active port in $ACTIVE_PORT_FILE — next deploy will re-derive it and may restart the wrong instance first"
fi
log "$ACTIVE_UNIT stopped; active port is now $NEW_PORT"

# --- final smoke test: poll the PUBLIC endpoint every second for
# --- SMOKE_DURATION_S. switch-proxy.sh already verified the commit matches
# --- once; this is the belt-and-braces "does it keep answering 200" check
# --- from issue #663's own spec. Any non-200 fails loudly and immediately —
# --- the switch already happened and the old instance is already gone, so
# --- there is nothing left to roll back to; a silent failure here would be
# --- exactly the "reports success while doing nothing" bug the Bible calls
# --- out. ---
i=0
while [ "$i" -lt "$SMOKE_DURATION_S" ]; do
  CODE="$(curl -s -o /dev/null -m 5 -w '%{http_code}' --resolve "${PUBLIC_HOST}:443:127.0.0.1" "$SMOKE_URL" 2>/dev/null || echo 000)"
  if [ "$CODE" != "200" ]; then
    err "post-switch smoke: $SMOKE_URL returned HTTP $CODE at check $((i + 1))/$SMOKE_DURATION_S — exiting non-zero"
    exit 1
  fi
  i=$((i + 1))
  sleep "$SMOKE_INTERVAL_S"
done

log "post-switch smoke clean for ${SMOKE_DURATION_S}s — deploy complete on port $NEW_PORT"
exit 0
