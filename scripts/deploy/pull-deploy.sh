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
#   PULL_DEPLOY_INPLACE          1 = restart the single existing unit in place
#                                instead of blue/green (a box with only one
#                                port free). Default is blue/green via
#                                scripts/deploy/blue-green-restart.sh — see
#                                docs/deploy/PULL-DEPLOY.md "Blue/green" for
#                                the rest of that script's env vars.
set -euo pipefail

APP_DIR="${GATETEST_APP_DIR:-/opt/gatetest}"
LOCK_FILE="${PULL_DEPLOY_LOCK:-/var/lock/gatetest-pull-deploy.lock}"
STATUS_FILE="${PULL_DEPLOY_STATUS_FILE:-/var/lib/gatetest/pull-deploy-status.json}"

# --- issue #706 part 3: read the PREVIOUS status before this run overwrites
# --- it, so a run of consecutive failures can be counted without a database
# --- — just the one file this script already owns. Field extraction is a
# --- grep+sed pair rather than a jq dependency: nothing else in this script
# --- (or deploy-on-box.sh) assumes jq is installed on the box, and the JSON
# --- this file holds is always the flat, single-line shape write_status()
# --- below produces, never nested.
prev_status_field() {
  # A quoted-string field, e.g. "result":"failed" -> failed. Empty (not an
  # error) when the file is absent, unreadable, or the key isn't present —
  # a first-ever run on a fresh box has no prior status to read. Reads only
  # the LAST line: pull-deploy-onfailure.sh (issue #706 part 3) APPENDS
  # rather than replaces, so a file left by a killed run can have more than
  # one JSON object in it — the newest one is always the one that matters,
  # same as website/app/lib/pull-deploy-status.js reads on the API side.
  # The pipeline runs inside an `if` condition: under `set -eo pipefail` a key that is
  # absent makes grep exit 1, a bare command substitution inherits that status,
  # and the assignment would end the whole script before it had written any
  # status at all (a status file from before #706 has no firstFailedAt; the
  # OnFailure append writes consecutiveFailures as null). An absent key is
  # an empty string, never a fatal error.
  [ -r "$STATUS_FILE" ] || { printf ''; return 0; }
  local v=""
  if v="$(tail -n1 "$STATUS_FILE" 2>/dev/null | grep -o "\"$1\":\"[^\"]*\"" | head -n1 | sed -E "s/.*:\"([^\"]*)\"/\1/")"; then printf "%s" "$v"; fi
}
prev_status_int_field() {
  # An unquoted integer field, e.g. "consecutiveFailures":3 -> 3. Same
  # last-line-only reasoning as prev_status_field above.
  [ -r "$STATUS_FILE" ] || { printf ''; return 0; }
  local v=""
  if v="$(tail -n1 "$STATUS_FILE" 2>/dev/null | grep -o "\"$1\":[0-9]\+" | head -n1 | sed -E "s/.*:([0-9]+)/\1/")"; then printf "%s" "$v"; fi
}
PREV_RESULT="$(prev_status_field result)"
PREV_CONSECUTIVE_FAILURES="$(prev_status_int_field consecutiveFailures)"
PREV_FIRST_FAILED_AT="$(prev_status_field firstFailedAt)"
if [ -z "$PREV_CONSECUTIVE_FAILURES" ]; then
  # No integer count on the last line. A "failed" line without one is the
  # OnFailure append (consecutiveFailures:null): that killed run WAS a
  # failure, so it counts as one; anything else starts from zero.
  if [ "$PREV_RESULT" = "failed" ]; then PREV_CONSECUTIVE_FAILURES=1; else PREV_CONSECUTIVE_FAILURES=0; fi
fi

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

  # issue #706 part 3: consecutiveFailures / firstFailedAt. A failure extends
  # the streak the PREVIOUS status file recorded (only when that run was ALSO
  # a failure — any success resets it); a non-failure result always resets
  # both to zero/empty, so a single good tick clears a run of prior trouble.
  local consecutive_failures="" first_failed_at=""
  if [ "$RESULT" = "failed" ]; then
    if [ "$PREV_RESULT" = "failed" ] && [ -n "$PREV_FIRST_FAILED_AT" ]; then
      consecutive_failures=$((PREV_CONSECUTIVE_FAILURES + 1))
      first_failed_at="$PREV_FIRST_FAILED_AT"
    else
      consecutive_failures=1
      first_failed_at="$(date -u +%FT%TZ)"
    fi
  else
    consecutive_failures=0
    first_failed_at=""
  fi

  if ! printf '{"at":"%s","before":"%s","after":"%s","result":"%s","reason":"%s","consecutiveFailures":%s,"firstFailedAt":"%s"}\n' \
    "$(date -u +%FT%TZ)" "$BEFORE" "$AFTER" "$RESULT" "$escaped_reason" "$consecutive_failures" "$first_failed_at" > "$tmp" 2>/dev/null; then
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

# GIT_TERMINAL_PROMPT=0: a revoked token or an interactive credential helper
# must never hang this unattended tick waiting on stdin — it must fail fast
# with something on stderr instead. That stderr is exactly what names the
# failure below (issue #706 part 3): before this, a failed fetch propagated
# through `set -e` with no call to fail()/write_status, so the status file
# kept reporting whatever the PREVIOUS tick had written while fetches were
# silently failing tick after tick.
FETCH_LOG="$STATUS_FILE.fetch-log.$$"
FETCH_RC=0
GIT_TERMINAL_PROMPT=0 git fetch origin main 2>"$FETCH_LOG" || FETCH_RC=$?
cat "$FETCH_LOG" >&2 2>/dev/null || true
if [ "$FETCH_RC" -ne 0 ]; then
  FETCH_FIRST_LINE="$(head -n1 "$FETCH_LOG" 2>/dev/null || true)"
  rm -f "$FETCH_LOG" 2>/dev/null
  fail "git fetch failed: ${FETCH_FIRST_LINE:-git fetch exited $FETCH_RC with no output on stderr}"
fi
rm -f "$FETCH_LOG" 2>/dev/null

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
#
# Restart strategy (issue #663): deploy-on-box.sh already supports a restart
# override, GATETEST_RESTART_CMD ("if -n GATETEST_RESTART_CMD; bash -c
# $GATETEST_RESTART_CMD" instead of its own systemd/pm2 auto-detect). Unless
# PULL_DEPLOY_INPLACE=1 (a box with only one port free), point that override
# at scripts/deploy/blue-green-restart.sh — see docs/deploy/PULL-DEPLOY.md
# "Blue/green" for what it does and how it flips the real front door
# (Coolify's Traefik, verified on box 161 2026-09-22 — not the
# tallrig-bun-gateway CLAUDE.md's Deployment Doctrine describes as the
# intended end state; Caddy and nginx remain untouched either way). $APP_DIR
# is already reset to $AFTER by deploy-on-box.sh's sync phase by the time the
# restart runs, so this reads from the just-deployed tree, not the box's
# previous copy.
# --- Never leave production frozen: blue/green needs the templated unit and
# --- the active-port file on this box (docs/deploy/PULL-DEPLOY.md "Blue/green",
# --- owner-run install). If either is missing, say so and deploy in place —
# --- the old behaviour with its brief 502 — rather than abort every tick
# --- until someone notices the live commit has stopped moving.
RESTART_MODE="blue-green"
if [ "${PULL_DEPLOY_INPLACE:-0}" = "1" ]; then
  RESTART_MODE="in-place"
  echo "[pull-deploy] PULL_DEPLOY_INPLACE=1 — restarting in place"
elif ! systemctl cat "${PULL_DEPLOY_UNIT_TEMPLATE:-gatetest-web@}.service" >/dev/null 2>&1; then
  RESTART_MODE="in-place"
  echo "[pull-deploy] WARNING: blue/green not installed on this box (no ${PULL_DEPLOY_UNIT_TEMPLATE:-gatetest-web@}.service template) — deploying in place; run scripts/deploy/install-pull-deploy.sh to enable zero-downtime deploys"
elif [ ! -r "${PULL_DEPLOY_ACTIVE_PORT_FILE:-/var/lib/gatetest/pull-deploy-active-port}" ]; then
  RESTART_MODE="in-place"
  echo "[pull-deploy] WARNING: blue/green installed but no active-port file at ${PULL_DEPLOY_ACTIVE_PORT_FILE:-/var/lib/gatetest/pull-deploy-active-port} — deploying in place; finish the bootstrap step in docs/deploy/PULL-DEPLOY.md"
fi

set +e
if [ "$RESTART_MODE" = "in-place" ]; then
  git show origin/main:scripts/deploy/deploy-on-box.sh | GATETEST_APP_DIR="$APP_DIR" PULL_DEPLOY_INPLACE=1 bash -s
else
  git show origin/main:scripts/deploy/deploy-on-box.sh | \
    GATETEST_APP_DIR="$APP_DIR" \
    GATETEST_RESTART_CMD="$APP_DIR/scripts/deploy/blue-green-restart.sh" \
    PULL_DEPLOY_EXPECTED_COMMIT="$AFTER" \
    bash -s
fi
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
