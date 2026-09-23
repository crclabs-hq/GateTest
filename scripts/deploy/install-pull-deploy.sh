#!/usr/bin/env bash
# install-pull-deploy.sh — one-time install of the pull-based deploy timer on
# the box (see docs/deploy/PULL-DEPLOY.md). Idempotent: safe to re-run after a
# later commit ships updated unit files or a fixed pull-deploy.sh.
#
# Deliberately narrow. It copies the unit files, reloads systemd, and enables
# the timer — nothing else. It never touches ufw, ssh, or tailscale: those are
# estate-managed (Box 161 hosts other products) and out of scope for a
# repo-shipped installer.
#
# Since issue #663 this also installs the blue/green pieces
# (gatetest-web@.service template, blue-green-restart.sh, switch-proxy.sh),
# but it never enables or starts a gatetest-web@<port> instance itself —
# migrating off the single gatetest-web.service is a one-time, judgment-call
# step (which port to bootstrap as "active", when to stop the old unit) that
# docs/deploy/PULL-DEPLOY.md "Blue/green" walks through by hand rather than
# something this installer should do unattended.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "install-pull-deploy: must run as root (sudo) — refusing." >&2
  exit 1
fi

APP_DIR="${GATETEST_APP_DIR:-/opt/gatetest}"
UNIT_DIR="$APP_DIR/scripts/deploy/systemd"
SERVICE="$UNIT_DIR/gatetest-pull-deploy.service"
ONFAILURE_SERVICE="$UNIT_DIR/gatetest-pull-deploy-onfailure.service"
TIMER="$UNIT_DIR/gatetest-pull-deploy.timer"
WEB_TEMPLATE="$UNIT_DIR/gatetest-web@.service"
SCRIPT="$APP_DIR/scripts/deploy/pull-deploy.sh"
ONFAILURE_SCRIPT="$APP_DIR/scripts/deploy/pull-deploy-onfailure.sh"
BLUE_GREEN_SCRIPT="$APP_DIR/scripts/deploy/blue-green-restart.sh"
SWITCH_SCRIPT="$APP_DIR/scripts/deploy/switch-proxy.sh"

for f in "$SERVICE" "$ONFAILURE_SERVICE" "$TIMER" "$WEB_TEMPLATE" "$SCRIPT" "$ONFAILURE_SCRIPT" "$BLUE_GREEN_SCRIPT" "$SWITCH_SCRIPT"; do
  if [ ! -f "$f" ]; then
    echo "install-pull-deploy: expected file not found: $f — run this from a checkout at GATETEST_APP_DIR (default /opt/gatetest)." >&2
    exit 1
  fi
done

chmod 755 "$SCRIPT" "$ONFAILURE_SCRIPT" "$BLUE_GREEN_SCRIPT" "$SWITCH_SCRIPT"
cp "$SERVICE" "$ONFAILURE_SERVICE" "$TIMER" "$WEB_TEMPLATE" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now gatetest-pull-deploy.timer

echo "[install-pull-deploy] installed and enabled. Current state:"
systemctl list-timers gatetest-pull-deploy.timer
echo "[install-pull-deploy] gatetest-web@.service template installed — see"
echo "[install-pull-deploy] docs/deploy/PULL-DEPLOY.md 'Blue/green' for the"
echo "[install-pull-deploy] one-time manual bootstrap onto it (not done by this script)."
