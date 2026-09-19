#!/usr/bin/env bash
# install-pull-deploy.sh — one-time install of the pull-based deploy timer on
# the box (see docs/deploy/PULL-DEPLOY.md). Idempotent: safe to re-run after a
# later commit ships updated unit files or a fixed pull-deploy.sh.
#
# Deliberately narrow. It copies two unit files, reloads systemd, and enables
# the timer — nothing else. It never touches ufw, ssh, or tailscale: those are
# estate-managed (Box 161 hosts other products) and out of scope for a
# repo-shipped installer.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "install-pull-deploy: must run as root (sudo) — refusing." >&2
  exit 1
fi

APP_DIR="${GATETEST_APP_DIR:-/opt/gatetest}"
UNIT_DIR="$APP_DIR/scripts/deploy/systemd"
SERVICE="$UNIT_DIR/gatetest-pull-deploy.service"
TIMER="$UNIT_DIR/gatetest-pull-deploy.timer"
SCRIPT="$APP_DIR/scripts/deploy/pull-deploy.sh"

if [ ! -f "$SERVICE" ] || [ ! -f "$TIMER" ] || [ ! -f "$SCRIPT" ]; then
  echo "install-pull-deploy: expected files not found under $APP_DIR — run this from a checkout at GATETEST_APP_DIR (default /opt/gatetest)." >&2
  exit 1
fi

chmod 755 "$SCRIPT"
cp "$SERVICE" "$TIMER" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now gatetest-pull-deploy.timer

echo "[install-pull-deploy] installed and enabled. Current state:"
systemctl list-timers gatetest-pull-deploy.timer
