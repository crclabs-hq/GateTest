#!/usr/bin/env bash
# deploy-on-box.sh — run ON the production box (the host in BOX_SSH_HOST) to bring the
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
# Production only ever deploys main. On 2026-09-15 the box was switched to a
# feature branch (jarvis/fix-874) and sat there 127 commits behind while every
# deploy refused on the dirty tree; `git reset --hard origin/main` below would
# have silently moved that branch onto main and hidden the switch. Refuse as
# loudly as the dirty-tree guard does, and say what to run.
# Opt-in recovery — DEPLOY_RECOVER=1, set only by a manual "Run workflow" with
# the recover box ticked (never by a push). Issue #542: the box sat on a feature
# branch with hand edits for days, 205 commits behind, because both guards below
# refuse (correctly) and the only fix was a human on SSH. Recovery never deletes
# anything: tracked edits are copied to a patch file, everything (untracked
# included) goes into a named stash, the old branch is left where it was, and
# only then does the checkout move to main. The guards below still run after it.
if [ "${DEPLOY_RECOVER:-0}" = "1" ]; then
  R_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  R_HEAD="$(git rev-parse --short HEAD)"
  R_DIRTY="$(git status --porcelain)"
  if [ "$R_BRANCH" != "main" ] || [ -n "$R_DIRTY" ]; then
    R_TAG="deploy-recover-$(date -u +%Y%m%dT%H%M%SZ)"
    echo "[deploy] RECOVER: box is on '$R_BRANCH' at $R_HEAD; changed paths:"
    printf '%s\n' "${R_DIRTY:-  (none)}"
    if [ -n "$R_DIRTY" ]; then
      if git diff HEAD > "/var/tmp/$R_TAG.patch"; then
        echo "[deploy] RECOVER: tracked edits copied to /var/tmp/$R_TAG.patch"
      else
        echo "[deploy] RECOVER: could not write the patch copy — the stash below is the only record" >&2
      fi
      git stash push -u -m "$R_TAG"
      echo "[deploy] RECOVER: stashed as '$R_TAG' — restore with: git stash list, then git stash apply <ref>"
    fi
    if [ "$R_BRANCH" != "main" ]; then
      git fetch origin main
      if git show-ref --verify --quiet refs/heads/main; then
        git checkout main
      else
        git checkout -b main origin/main
      fi
      echo "[deploy] RECOVER: switched from '$R_BRANCH' ($R_HEAD) to main — the old branch is untouched"
    fi
  else
    echo "[deploy] RECOVER: requested, but the box is already clean on main — nothing to recover"
  fi
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  echo "[deploy] ERROR: $APP_DIR is on branch '$BRANCH', not main — production deploys main only." >&2
  echo "[deploy]        Save any hand edits first (git stash push -u -m box-edits-$(date -u +%F), then re-apply them in a PR)," >&2
  echo "[deploy]        then: cd $APP_DIR && git checkout main && re-run the Deploy workflow." >&2
  exit 1
fi
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
# --- end of sync phase --- (tests/deploy-recover.test.js runs the script up to this line)

if [ "$BEFORE" = "$AFTER" ]; then
  if [ "${1:-}" = "--force-build" ]; then
    echo "[deploy] already at $AFTER — rebuilding on request (--force-build)"
  elif [ ! -f website/.next/BUILD_ID ]; then
    # #723: a current checkout with no build on disk is not "nothing to do" —
    # the running process is serving without its files.
    echo "[deploy] already at $AFTER but no production build on disk (website/.next/BUILD_ID missing) — rebuilding"
  else
    echo "[deploy] already at $AFTER — nothing to do (use --force-build to rebuild anyway)"
    exit 0
  fi
fi

echo "[deploy] $BEFORE -> $AFTER"

# A hung `next build` must not block every future deploy. Next 16 takes an
# OS-level exclusive lock on website/.next/lock through its native binding
# (build/index.js → Lockfile.acquireWithRetriesOrExit); the lock is held by a
# LIVE process, so a build that hangs (or is orphaned when an SSH session
# drops) holds it forever and every later deploy dies six seconds in with
# "Another next build process is already running" — 2026-09-10, twice
# (1b1ad5db, 3a831a84). Policy: a build younger than BUILD_GRACE_S is a real
# concurrent build → wait for it; older than that it is hung → kill it and
# proceed. Deploy builds on this box finish in well under ten minutes.
BUILD_GRACE_S="${GATETEST_BUILD_GRACE_S:-900}"
for _ in $(seq 1 60); do
  hung=0; young=0
  for pid in $(pgrep -f "next build" 2>/dev/null || true); do
    [ "$pid" = "$$" ] && continue
    age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ' || echo 0)
    if [ "${age:-0}" -gt "$BUILD_GRACE_S" ]; then
      echo "[deploy] killing hung next build pid $pid (running ${age}s > ${BUILD_GRACE_S}s)"
      # gatetest:swallow-ok reason="best-effort kill of a build we have already decided is hung: the pid can exit between pgrep and kill, and a missing process is the outcome we want; the deploy must not abort because the cleanup found nothing to clean"
      kill "$pid" 2>/dev/null || true; sleep 2; kill -9 "$pid" 2>/dev/null || true
      hung=1
    else
      young=1
    fi
  done
  [ "$young" = 1 ] || break
  echo "[deploy] another next build is in progress — waiting 10s for it to finish"
  sleep 10
done
if pgrep -f "next build" >/dev/null 2>&1; then
  echo "[deploy] ERROR: a next build is still running after waiting — not starting a second one" >&2
  pgrep -af "next build" >&2 || true
  exit 1
fi

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
SMOKE_FAILED=0
for probe in "https://gatetest.io/" "https://gatetest.io/pricing" "https://gatetest.io/api/status" "https://gatetest.io/icon.png"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$probe" || echo 000)
  echo "[deploy] smoke $probe -> $code"
  [ "$code" = "200" ] || SMOKE_FAILED=1
done
if [ "$SMOKE_FAILED" = "1" ]; then
  # #723: the health endpoints passed while / served a bare 500; a deploy whose
  # front door does not answer 200 is a failed deploy and must say so.
  echo "[deploy] ERROR: post-deploy smoke failed — a probed route did not return 200 (see the lines above)" >&2
  exit 3
fi
echo "[deploy] done — verify /api/status shows ready:true"
