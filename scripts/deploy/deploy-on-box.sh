#!/usr/bin/env bash
# deploy-on-box.sh — run ON the production box (66.42.121.161) to bring the
# live site up to date with origin/main. Idempotent; safe to re-run.
#
# Called two ways:
#   1. Manually over SSH:      bash scripts/deploy/deploy-on-box.sh
#   2. By the deploy-box.yml GitHub Action on every push to main.
#
# Environment (set on the box, optional):
#   GATETEST_APP_DIR      — repo checkout path   (default: the repo this script lives in)
#   GATETEST_RESTART_CMD  — restart command      (default: auto-detect pm2 'gatetest',
#                           then systemd 'gatetest', else warn and skip)
set -euo pipefail

APP_DIR="${GATETEST_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$APP_DIR"

echo "[deploy] $(date -u +%FT%TZ) — deploying $(git rev-parse --abbrev-ref HEAD) in $APP_DIR"

# Refuse to clobber uncommitted changes on the box — a box should never have
# any a HUMAN made. But THIS SCRIPT makes some every time it runs: `npm install`
# rewrites package-lock.json, and the website `prebuild` regenerates the tracked
# build-info.json to stamp the git SHA. Both happen AFTER the check below, so
# the second deploy on any box hit "uncommitted changes — resolve manually
# first" and refused to run. The guard made the script single-use, which is a
# large part of why /opt/gatetest sat at a July 31 checkout serving a July 29
# build: the automated path had locked itself out and every later deploy was a
# manual one that nobody did.
#
# So: ignore the files this script is known to dirty. `git reset --hard` below
# discards them anyway — they were never at risk. Anything else still blocks.
# Every file the website `prebuild` writes belongs here — tests/deploy-self-dirtied.test.js
# derives that list from website/package.json and fails when one is missing. It
# happened once already: Move 39 (2026-09-05) added generate-changelog.js to the
# prebuild, changelog.json was not listed, and the next five deploys refused
# themselves while production sat 85 commits behind main.
SELF_DIRTIED='package-lock.json website/app/data/build-info.json website/app/data/changelog.json website/package-lock.json'
UNEXPECTED="$(git status --porcelain --untracked-files=no | awk '{print $2}' | while read -r f; do
  case " $SELF_DIRTIED " in *" $f "*) ;; *) echo "$f" ;; esac
done)"
if [ -n "$UNEXPECTED" ]; then
  echo "[deploy] ERROR: unexpected uncommitted changes on the box — resolve manually first." >&2
  echo "$UNEXPECTED" >&2
  exit 1
fi

BEFORE=$(git rev-parse HEAD)
git fetch origin main
git reset --hard origin/main
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  echo "[deploy] already at $AFTER — nothing to do (use --force-build to rebuild anyway)"
  [ "${1:-}" = "--force-build" ] || exit 0
fi

echo "[deploy] $BEFORE -> $AFTER"

# Clear a STALE Next.js build lock. `next build` refuses to start while
# `next.lock/lock.json` exists ("Another next build process is already
# running"), and a build that was killed or crashed leaves the lock behind —
# the 2026-09-10 deploy of 1b1ad5db failed exactly this way, six seconds in,
# with nothing actually building. The lock records the pid; if that process
# is gone (or there is no `next build` running at all), the lock is a corpse.
# A LIVE build keeps its lock and this deploy fails loudly, as it should.
for lock in website/.next/next.lock/lock.json website/next.lock/lock.json; do
  [ -f "$lock" ] || continue
  pid=$(node -e "try{const j=require(process.argv[1]);console.log(j.pid||j.serverInfo?.pid||'')}catch{console.log('')}" "$(pwd)/$lock" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "[deploy] ERROR: a next build (pid $pid) is still running — not clearing $lock" >&2
    exit 1
  fi
  if pgrep -f "next build" >/dev/null 2>&1; then
    echo "[deploy] ERROR: a next build is running without a readable pid in $lock — not clearing it" >&2
    exit 1
  fi
  echo "[deploy] removing stale build lock $lock (pid '${pid:-none}' is not running)"
  rm -rf "$(dirname "$lock")"
done

npm install --no-audit --no-fund
# `npm run build`, NOT `npx next build` — the `prebuild` script stamps the real
# git SHA into build-info.json, which is what /api/platform-status reports. A
# bare `next build` skips prebuild, so the site would serve NEW code while
# still reporting the OLD commit: the deploy looks like it never happened, and
# the production-drift check in deploy-box.yml is reading that same field.
# (CLAUDE.md quality bar #12; docs/deploy/VAPRON-DEPLOY.md §1.)
(cd website && npm install --no-audit --no-fund && npm run build)

# Restart the service.
if [ -n "${GATETEST_RESTART_CMD:-}" ]; then
  echo "[deploy] restarting via GATETEST_RESTART_CMD"
  bash -c "$GATETEST_RESTART_CMD"
elif command -v pm2 >/dev/null 2>&1 && pm2 describe gatetest >/dev/null 2>&1; then
  echo "[deploy] restarting pm2 process 'gatetest'"
  pm2 restart gatetest --update-env
else
  # The unit on the production box is `gatetest-web.service`, not
  # `gatetest.service`. This block matched only the exact name `gatetest.service`
  # until 2026-08-05, so on the box that actually serves gatetest.io it fell
  # through to the warning below: the deploy would fetch, build, print
  # "done", exit 0 — and leave the OLD process serving. A deploy that reports
  # success without restarting is the same class of bug as the CI workflow that
  # reported success without deploying (5b8e5be3).
  # Read the unit list ONCE into a variable and glob-match it. Do NOT pipe into
  # `grep -q` here: this script runs under `set -o pipefail`, and `grep -q`
  # exits the instant it matches, which closes the pipe and kills `systemctl`
  # with SIGPIPE (141). pipefail then reports 141 for the whole pipeline, so the
  # `if` is FALSE precisely when the unit DOES exist. That is why the original
  # `grep -q '^gatetest\.service'` never fired either — the bug was never really
  # the unit name, it was the pipeline. Verified on the box 2026-08-05:
  # the same grep prints MATCH interactively and fails inside this script.
  #
  # `|| true` used to hide BOTH cases here: systemd absent, and systemd present
  # but list-unit-files failing. Those are not the same event. The first is a
  # non-systemd box, which the warning below already covers; the second means we
  # cannot tell whether the unit exists, and a deploy that cannot find out
  # whether it restarted anything must not report success. This is the same
  # class of swallow that let /opt/gatetest sit 60 commits stale for six days.
  UNIT_FILES=""
  if command -v systemctl >/dev/null 2>&1; then
    if ! UNIT_FILES="$(systemctl list-unit-files --no-legend)"; then
      echo "[deploy] ERROR: 'systemctl list-unit-files' failed — cannot determine the restart unit." >&2
      echo "[deploy]        The new build is in place but the OLD process may still be serving." >&2
      exit 1
    fi
  fi
  RESTART_UNIT=""
  for unit in gatetest-web gatetest; do
    case "$UNIT_FILES" in
      *"${unit}.service"*) RESTART_UNIT="$unit"; break ;;
    esac
  done
  if [ -n "$RESTART_UNIT" ]; then
    echo "[deploy] restarting systemd unit '$RESTART_UNIT'"
    systemctl restart "$RESTART_UNIT"
  else
    echo "[deploy] WARNING: no restart mechanism found (set GATETEST_RESTART_CMD) — build is in place but the old process is still serving." >&2
  fi
fi

# Post-deploy smoke: the endpoints that burned us when the box served a stale build.
sleep 3
for probe in "https://gatetest.io/api/status" "https://gatetest.io/icon.png"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$probe" || echo 000)
  echo "[deploy] smoke $probe -> $code"
done
echo "[deploy] done — verify /api/status shows ready:true"
