#!/usr/bin/env bash
# install-workspaces.sh — POSIX-compatible bash workspace installer.
#
# Walks the repo, finds every package.json (excluding node_modules/.next/build),
# and runs `npm ci` if package-lock.json is present, falling back to
# `npm install` if no lockfile exists. Idempotent — safe to run multiple times.
#
# This kills the brittle "remember to cd website && npm ci" pattern.
# Every CI job should call this single script.
#
# Network resilience: GitHub Actions runners regularly hit transient
# ECONNRESET / 503 / DNS hiccups against the npm registry mid-install. A
# single transient blip should not fail CI — every install is wrapped in
# a 3-attempt retry with exponential backoff (5s, 15s, 30s).
#
# Usage:
#   bash scripts/install-workspaces.sh [repo_root]
#
# Exit codes:
#   0 — all installs succeeded
#   1 — at least one install failed after all retries
set -euo pipefail

ROOT_DIR="${1:-$(pwd)}"
MAX_ATTEMPTS=3
BACKOFF_SECONDS=(0 5 15 30)  # index = attempt number; 0 is unused

if [ ! -d "$ROOT_DIR" ]; then
  echo "install-workspaces: root directory '$ROOT_DIR' does not exist" >&2
  exit 1
fi

# Run `npm ci` (or `npm install`) with retry. Cleans node_modules between
# attempts so a half-written tree from a failed install doesn't poison
# the next try.
#
# $1 — directory to install in
# $2 — "ci" or "install"
npm_with_retry() {
  local dir="$1"
  local mode="$2"
  local attempt=1
  local cmd
  if [ "$mode" = "ci" ]; then
    cmd="npm ci"
  else
    cmd="npm install --no-audit --no-fund"
  fi

  while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    if [ "$attempt" -gt 1 ]; then
      local wait_s="${BACKOFF_SECONDS[$attempt]}"
      echo "install-workspaces: attempt $attempt/$MAX_ATTEMPTS for '$dir' after ${wait_s}s backoff"
      sleep "$wait_s"
      # Clean half-written tree before retrying. ECONNRESET mid-extract
      # leaves dangling symlinks that confuse the next npm ci.
      rm -rf "$dir/node_modules" 2>/dev/null || true
    fi
    if ( cd "$dir" && $cmd ); then
      return 0
    fi
    echo "install-workspaces: $cmd failed in '$dir' (attempt $attempt/$MAX_ATTEMPTS)" >&2
    attempt=$((attempt + 1))
  done
  return 1
}

echo "install-workspaces: scanning '$ROOT_DIR' for package.json files..."

# Find every package.json, excluding node_modules, .next, build, .git output.
# -print0 + xargs would be safer, but we want a readable per-dir loop.
# Using a temp file avoids subshell scope issues for INSTALLED counter.
TMP_LIST="$(mktemp)"
trap 'rm -f "$TMP_LIST"' EXIT

find "$ROOT_DIR" \
  -type d \( -name node_modules -o -name .next -o -name build -o -name .git \) -prune \
  -o -type f -name package.json -print \
  | sort > "$TMP_LIST"

INSTALLED=0
FAILED=0

while IFS= read -r PKG_JSON; do
  PKG_DIR="$(dirname "$PKG_JSON")"

  # Skip the .claude/ worktrees — they're nested checkouts of the same repo.
  case "$PKG_DIR" in
    *"/.claude/"*)
      continue
      ;;
  esac

  if [ -f "$PKG_DIR/package-lock.json" ]; then
    echo "install-workspaces: npm ci in '$PKG_DIR'"
    if npm_with_retry "$PKG_DIR" "ci"; then
      INSTALLED=$((INSTALLED + 1))
    else
      echo "install-workspaces: FAILED npm ci in '$PKG_DIR' after $MAX_ATTEMPTS attempts" >&2
      FAILED=$((FAILED + 1))
      exit 1
    fi
  else
    echo "install-workspaces: npm install in '$PKG_DIR' (no lockfile)"
    if npm_with_retry "$PKG_DIR" "install"; then
      INSTALLED=$((INSTALLED + 1))
    else
      echo "install-workspaces: FAILED npm install in '$PKG_DIR' after $MAX_ATTEMPTS attempts" >&2
      FAILED=$((FAILED + 1))
      exit 1
    fi
  fi
done < "$TMP_LIST"

echo "install-workspaces: done. installed=$INSTALLED failed=$FAILED"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
