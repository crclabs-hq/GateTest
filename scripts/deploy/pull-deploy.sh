#!/usr/bin/env bash
# pull-deploy.sh — run ON the production box from a systemd timer. The box
# deploys itself; nothing reaches in.
#
# Box 161 closed public SSH (port 22) on 2026-09-16 as part of estate
# hardening, so .github/workflows/deploy-box.yml can no longer SSH in to run
# scripts/deploy/deploy-on-box.sh. This is the replacement: instead of GitHub
# pushing a deploy to the box, the box pulls on a 5-minute timer
# (gatetest-pull-deploy.timer) and deploys itself when origin/main has moved.
#
# The common case (nothing new) costs exactly one `git fetch` — no build, no
# work. See docs/deploy/PULL-DEPLOY.md for install + operations.
#
# Environment (optional):
#   GATETEST_APP_DIR             repo checkout path        (default: /opt/gatetest)
#   PULL_DEPLOY_LOCK             flock path                (default: /var/lock/gatetest-pull-deploy.lock)
#   PULL_DEPLOY_STATUS_FILE      one-line JSON status path (default: /var/lib/gatetest/pull-deploy-status.json)
#   PULL_DEPLOY_EXPECTED_ORIGIN  newline-separated list of origin URLs this box
#                                is allowed to deploy from — overrides the
#                                built-in GateTest github.com URLs. Tests use
#                                this to point at a throwaway repo; there is no
#                                other reason to set it.
set -euo pipefail

APP_DIR="${GATETEST_APP_DIR:-/opt/gatetest}"
LOCK_FILE="${PULL_DEPLOY_LOCK:-/var/lock/gatetest-pull-deploy.lock}"
STATUS_FILE="${PULL_DEPLOY_STATUS_FILE:-/var/lib/gatetest/pull-deploy-status.json}"

# Box 161 hosts other products; anyone who can land a commit on THIS repo's
# main effectively gets root on the box the moment this timer runs it. Branch
# protection (four required checks, no force-push) is what stands between a
# contributor and the box today — see docs/deploy/PULL-DEPLOY.md "Security
# model". These two checks are the box-side backstop for that trust chain:
# never execute anything piped from git without first confirming (a) it came
# from the real repo and (b) it is a fast-forward of what is already deployed.
DEFAULT_EXPECTED_ORIGINS='https://github.com/crclabs-hq/GateTest
git@github.com:crclabs-hq/GateTest.git'
EXPECTED_ORIGINS="${PULL_DEPLOY_EXPECTED_ORIGIN:-$DEFAULT_EXPECTED_ORIGINS}"

BEFORE=""
AFTER=""
RESULT="failed"
REASON=""

# https://github.com/org/repo(.git) and git@github.com:org/repo(.git) both
# normalise to the same string, so a box configured with either remote form
# still matches.
normalize_origin() {
  local raw="${1%.git}"
  case "$raw" in
    git@github.com:*) raw="https://github.com/${raw#git@github.com:}" ;;
  esac
  printf '%s\n' "$raw"
}

# Best-effort: a status file that cannot be written is a warning, never a
# deploy failure — the deploy's own exit code is still the truth.
write_status() {
  local dir tmp
  dir="$(dirname "$STATUS_FILE")"
  if ! mkdir -p "$dir" 2>/dev/null; then
    echo "[pull-deploy] WARNING: could not create $dir — status not recorded" >&2
    return 0
  fi
  tmp="$STATUS_FILE.tmp.$$"
  local escaped_reason
  escaped_reason="$(printf '%s' "$REASON" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  if ! printf '{"at":"%s","before":"%s","after":"%s","result":"%s","reason":"%s"}\n' \
    "$(date -u +%FT%TZ)" "$BEFORE" "$AFTER" "$RESULT" "$escaped_reason" > "$tmp" 2>/dev/null; then
    echo "[pull-deploy] WARNING: could not write $tmp — status not recorded" >&2
    rm -f "$tmp" 2>/dev/null
    return 0
  fi
  if ! mv "$tmp" "$STATUS_FILE" 2>/dev/null; then
    echo "[pull-deploy] WARNING: could not move status into place at $STATUS_FILE" >&2
    rm -f "$tmp" 2>/dev/null
  fi
  return 0
}

fail() {
  REASON="$1"
  RESULT="failed"
  echo "[pull-deploy] ERROR: $REASON" >&2
  write_status
  exit "${2:-1}"
}

cd "$APP_DIR"

# --- Provenance check (a): this must be the real repo, not something an ---
# --- attacker pointed `origin` at.                                      ---
if ! ACTUAL_ORIGIN="$(git remote get-url origin)"; then
  fail "could not read 'git remote get-url origin' in $APP_DIR"
fi
ACTUAL_NORM="$(normalize_origin "$ACTUAL_ORIGIN")"
ORIGIN_OK=0
while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  if [ "$(normalize_origin "$candidate")" = "$ACTUAL_NORM" ]; then
    ORIGIN_OK=1
    break
  fi
done <<EOF_ORIGINS
$EXPECTED_ORIGINS
EOF_ORIGINS
if [ "$ORIGIN_OK" -ne 1 ]; then
  fail "origin remote is not the expected GateTest repository (got '$ACTUAL_ORIGIN')"
fi

# --- Serialize: two ticks must never overlap. A held lock is not a failure —
# --- the other tick owns this run and will report its own status.
LOCK_DIR="$(dirname "$LOCK_FILE")"
mkdir -p "$LOCK_DIR"
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  echo "[pull-deploy] another run already holds the lock — exiting"
  exit 0
fi

git fetch origin main

BEFORE="$(git rev-parse HEAD)"
AFTER="$(git rev-parse origin/main)"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [ "$BEFORE" = "$AFTER" ] && [ "$CURRENT_BRANCH" = "main" ]; then
  RESULT="up-to-date"
  REASON=""
  echo "[pull-deploy] up to date at $AFTER"
  write_status
  exit 0
fi

# --- Provenance check (b): origin/main must be a fast-forward of what is ---
# --- already deployed. A rewritten or force-pushed main (branch protection ---
# --- forbids force-push, but this is the box-side backstop, not a substitute ---
# --- for it) must never be deployed silently.
if ! git merge-base --is-ancestor "$BEFORE" "$AFTER"; then
  fail "origin/main is not a fast-forward of the deployed commit"
fi

echo "[pull-deploy] $BEFORE -> $AFTER"
echo "[pull-deploy] deploying from origin/main (never this box's stale copy — same reason deploy-box.yml streams the script instead of exec'ing the box's own)"

# Run the deploy script AS PUBLISHED ON origin/main, not the box's own copy —
# a fix to the deploy script can never reach the box through the box's own
# stale script (see the long comment on this exact point in
# .github/workflows/deploy-box.yml, "Deploy over SSH").
set +e
git show origin/main:scripts/deploy/deploy-on-box.sh | GATETEST_APP_DIR="$APP_DIR" bash -s
DEPLOY_RC=$?
set -e

if [ "$DEPLOY_RC" -eq 0 ]; then
  RESULT="deployed"
  REASON=""
else
  RESULT="failed"
  REASON="deploy-on-box.sh exited $DEPLOY_RC"
fi
write_status
exit "$DEPLOY_RC"
