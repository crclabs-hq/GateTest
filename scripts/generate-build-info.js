#!/usr/bin/env node
'use strict';
/**
 * Stamp the real git commit into the build so a STALE DEPLOY IS VISIBLE.
 *
 * The live site served `version:"dev"`, `commit:"unknown"` for days while
 * showing wrong module counts and a dead model name — nobody could tell the
 * box was running an old build. This writes website/app/data/build-info.json
 * at build time; /api/platform-status serves it. If the SHA there doesn't
 * match `main`'s tip, the deploy is stale — full stop.
 *
 * Runs as website `prebuild` (so `npm run build` stamps automatically) and
 * from the dogfood-nightly workflow. Degrades gracefully with no git context.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'website', 'app', 'data', 'build-info.json');

// No shell, fixed argv — nothing interpolated, so no command-injection surface.
function tryGit(args, fallback) {
  try {
    return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return fallback;
  }
}

// Env wins (a deploy platform may inject its own), then git, then "unknown".
const commit =
  process.env.GIT_COMMIT ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  tryGit(['rev-parse', 'HEAD'], 'unknown');

const shortCommit = commit !== 'unknown' ? commit.slice(0, 7) : 'unknown';

let version = process.env.APP_VERSION || '';
if (!version) {
  // Derive from the Bible's `GateTest vX.Y.Z` string so it tracks releases.
  try {
    const bible = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');
    const m = bible.match(/GateTest v(\d+\.\d+\.\d+)/);
    version = m ? m[1] : 'dev';
  } catch {
    version = 'dev';
  }
}

const info = {
  version,
  commit,
  shortCommit,
  builtAt: new Date().toISOString(),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(info, null, 2) + '\n');
console.log(`[build-info] ${version} @ ${shortCommit} (${info.builtAt})`);
