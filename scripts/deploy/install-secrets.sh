#!/usr/bin/env bash
# install-secrets.sh — one-time (idempotent) box install for the admin secrets
# panel. See docs/ops/secrets-panel.md. Run as root from the checkout:
#
#   sudo bash /opt/gatetest/scripts/deploy/install-secrets.sh
#
# It:
#   1. creates /var/lib/gatetest/unit-env owned by the web unit's user, 0700
#      (the ONLY writer is the web app; every helper unit hides the directory
#      with InaccessiblePaths=);
#   2. installs gatetest-secrets-apply.path + .service and the updated
#      gatetest-web@.service template (platform.env as its LAST EnvironmentFile);
#   3. enables the path unit.
# It never writes a secret, never reads one, and prints no value — it only
# says whether GATETEST_SECRETS_MASTER_KEY is present in the app env file, by
# name. Generating and typing that key is the owner's step (the doc says how).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "install-secrets: must run as root (sudo) — refusing." >&2
  exit 1
fi

APP_DIR="${GATETEST_APP_DIR:-/opt/gatetest}"
UNIT_SRC="$APP_DIR/scripts/deploy/systemd"
UNIT_DST="${GATETEST_SYSTEMD_DIR:-/etc/systemd/system}"
UNIT_ENV_DIR="${GATETEST_UNIT_ENV_DIR:-/var/lib/gatetest/unit-env}"
APP_ENV_FILE="${GATETEST_APP_ENV_PATH:-$APP_DIR/website/.env.local}"

for f in "$UNIT_SRC/gatetest-secrets-apply.path" "$UNIT_SRC/gatetest-secrets-apply.service" \
         "$UNIT_SRC/gatetest-web@.service" "$APP_DIR/scripts/deploy/secrets-apply.sh" \
         "$APP_DIR/scripts/deploy/blue-green-restart.sh"; do
  if [ ! -f "$f" ]; then
    echo "install-secrets: expected file not found: $f — run this from a checkout at GATETEST_APP_DIR (default /opt/gatetest)." >&2
    exit 1
  fi
done

# The web unit's User= decides who owns the directory (root today; see
# docs/deploy/PULL-DEPLOY.md "Recommended hardening: run as non-root").
WEB_USER="$(sed -n 's/^User=//p' "$UNIT_SRC/gatetest-web@.service" | tail -n 1)"
WEB_USER="${WEB_USER:-root}"
WEB_GROUP="$(id -gn "$WEB_USER")"

install -d -m 0700 -o "$WEB_USER" -g "$WEB_GROUP" "$UNIT_ENV_DIR"
chmod 0700 "$UNIT_ENV_DIR"
chown "$WEB_USER:$WEB_GROUP" "$UNIT_ENV_DIR"
chmod 755 "$APP_DIR/scripts/deploy/secrets-apply.sh"

cp "$UNIT_SRC/gatetest-secrets-apply.path" "$UNIT_SRC/gatetest-secrets-apply.service" "$UNIT_SRC/gatetest-web@.service" "$UNIT_DST/"
systemctl daemon-reload
systemctl enable --now gatetest-secrets-apply.path

echo "[install-secrets] $UNIT_ENV_DIR: owner $WEB_USER, mode 0700"
if [ -r "$APP_ENV_FILE" ] && grep -q '^GATETEST_SECRETS_MASTER_KEY=..*' "$APP_ENV_FILE"; then
  echo "[install-secrets] GATETEST_SECRETS_MASTER_KEY: present in $APP_ENV_FILE"
else
  echo "[install-secrets] GATETEST_SECRETS_MASTER_KEY: NOT present in $APP_ENV_FILE — the panel stays read-only until you add it (docs/ops/secrets-panel.md step 1)"
fi
echo "[install-secrets] the running web instances load the new template on their next blue/green restart:"
echo "[install-secrets]   sudo bash $APP_DIR/scripts/deploy/secrets-apply.sh"
