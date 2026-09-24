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
set -euo pipefail

STATUS_FILE="${PULL_DEPLOY_STATUS_FILE:-/var/lib/gatetest/pull-deploy-status.json}"
UNIT_NAME="${1:-gatetest-pull-deploy.service}"

DIR="$(dirname "$STATUS_FILE")"
mkdir -p "$DIR" 2>/dev/null || exit 0

REASON="$UNIT_NAME was killed before it could record its own status (systemd OnFailure safety net)"
NOW="$(date -u +%FT%TZ)"

# Append, never overwrite — the normal write_status() in pull-deploy.sh
# replaces the file atomically each tick; this is the one path that adds a
# line instead, so a run that raced this one (unlikely, but the file has no
# lock of its own) never loses the OTHER side's record. Readers (e.g.
# website/app/lib/pull-deploy-status.js) already read the LAST non-empty
# line, so an appended file behaves exactly like a replaced one.
printf '{"at":"%s","before":"","after":"","result":"failed","reason":"%s","consecutiveFailures":null,"firstFailedAt":"%s"}\n' \
  "$NOW" "$REASON" "$NOW" >> "$STATUS_FILE" 2>/dev/null || exit 0
