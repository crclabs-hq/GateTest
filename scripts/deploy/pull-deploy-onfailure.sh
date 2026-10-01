#!/usr/bin/env bash
# pull-deploy-onfailure.sh — the box-side safety net for a KILLED
# gatetest-pull-deploy.service run (issue #706 part 3).
#
# pull-deploy.sh records every failure it can SEE (a bad origin, a
# non-fast-forward main, a failed fetch, deploy-on-box.sh exiting non-zero)
# through its own fail()/write_status. But a run that is killed outright —
# TimeoutStartSec=1800 expiring on a hung build, an OOM kill, `systemctl
# stop` — never reaches that code at all, so the status file keeps showing
# whatever the PREVIOUS tick wrote while the box quietly stopped deploying.
# A wrong-but-old status is exactly the failure mode #706 exists to close.
#
# Wired via `OnFailure=gatetest-pull-deploy-onfailure.service` on
# gatetest-pull-deploy.service (see docs/deploy/PULL-DEPLOY.md): systemd runs
# this unit whenever the main one fails for ANY reason, including a kill this
# script never got a chance to explain from inside. Deliberately tiny — one
# job, append one line to the SAME status file /api/platform-status already
# reads, never touch anything else.
#
# WHEN IT APPENDS (fixed 2026-09-30): only when the failed run did not record
# itself. systemd fires OnFailure= for EVERY non-zero exit, including the
# ordinary failures pull-deploy.sh already explained through fail(). On box 161
# that made a correctly recorded "not a fast-forward" refusal get a "killed"
# line appended on top of it every tick for three days, and every reader (the
# last line wins) showed the wrong reason. The decision is evidence, not
# assumption: pull-deploy.sh writes the systemd $INVOCATION_ID of its run as
# "run" in its status line, and this script asks systemd for the failed unit's
# InvocationID. Same id on the last line = that run recorded itself, do
# nothing. Different or absent id = that run never wrote, append the record.
# If systemd cannot say which invocation failed, the record says so instead of
# guessing a cause (never report the wrong reason; say what was not checked).
set -euo pipefail

STATUS_FILE="${PULL_DEPLOY_STATUS_FILE:-/var/lib/gatetest/pull-deploy-status.json}"
UNIT_NAME="${1:-gatetest-pull-deploy.service}"

DIR="$(dirname "$STATUS_FILE")"
mkdir -p "$DIR" 2>/dev/null || exit 0

# What systemd says about the run that just failed. The lookup sits inside an
# `if` so a missing systemctl, or a unit it cannot show, yields "" (unknown)
# and never fails this unit.
unit_property() {
  local v=""
  if command -v systemctl >/dev/null 2>&1; then
    if ! v="$(systemctl show -p "$1" --value "$UNIT_NAME" 2>/dev/null)"; then v=""; fi
  fi
  printf '%s' "$v"
}
UNIT_INVOCATION="$(unit_property InvocationID)"
UNIT_RESULT="$(unit_property Result)"

# The "run" pull-deploy.sh wrote on the LAST non-empty line ("" when the file
# is absent, the line predates this field, or that run was not under systemd).
LAST_RUN=""
if [ -r "$STATUS_FILE" ]; then
  if ! LAST_RUN="$(grep -v '^[[:space:]]*$' "$STATUS_FILE" | tail -n1 | grep -o '"run":"[^"]*"' | head -n1 | sed -E 's/.*:"([^"]*)"/\1/')"; then LAST_RUN=""; fi
fi

if [ -n "$UNIT_INVOCATION" ] && [ "$LAST_RUN" = "$UNIT_INVOCATION" ]; then
  echo "[pull-deploy-onfailure] $UNIT_NAME failed but recorded its own status (run $UNIT_INVOCATION) — leaving it as written"
  exit 0
fi

if [ -z "$UNIT_INVOCATION" ]; then
  REASON="$UNIT_NAME failed and this safety net could not tell whether that run recorded its own status (systemd reported no InvocationID for the unit); the previous line may belong to an earlier run"
else
  VERB="was killed"
  if [ "$UNIT_RESULT" = "exit-code" ]; then VERB="exited non-zero"; fi
  REASON="$UNIT_NAME $VERB before it could record its own status (systemd OnFailure safety net"
  if [ -n "$UNIT_RESULT" ]; then REASON="$REASON, Result=$UNIT_RESULT"; fi
  REASON="$REASON)"
fi
NOW="$(date -u +%FT%TZ)"

# Append, never overwrite — the normal write_status() in pull-deploy.sh
# replaces the file atomically each tick; this is the one path that adds a
# line instead, so a run that raced this one (unlikely, but the file has no
# lock of its own) never loses the OTHER side's record. Readers (e.g.
# website/app/lib/pull-deploy-status.js) already read the LAST non-empty
# line, so an appended file behaves exactly like a replaced one. The run id is
# written too, so a second OnFailure for the same invocation finds it recorded.
printf '{"at":"%s","before":"","after":"","result":"failed","reason":"%s","consecutiveFailures":null,"firstFailedAt":"%s","run":"%s"}\n' \
  "$NOW" "$REASON" "$NOW" "$UNIT_INVOCATION" >> "$STATUS_FILE" 2>/dev/null || exit 0
