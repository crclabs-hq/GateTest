#!/usr/bin/env node
/**
 * Arena bug injector.
 *
 * Picks a random pattern from bug-patterns/patterns.json, applies it to
 * src/math.js, creates a branch, commits, and opens a PR. The PR's CI
 * fails — that's the whole point — and the ai-ci-fixer workflow takes
 * over from there.
 *
 * Idempotent: if a pattern's `find` text is missing (e.g. previous cycle
 * left the file in a different state), exits 0 with a SKIP marker. The
 * next scheduled run picks a different pattern.
 *
 * Run with:
 *   node scripts/inject-bug.js
 *
 * Required env:
 *   GITHUB_TOKEN  — PAT or GITHUB_TOKEN with repo + pull-requests scope
 *   GITHUB_REPOSITORY — owner/repo (auto-set in Actions)
 *
 * Optional env:
 *   ARENA_PATTERN_ID  — force a specific pattern (default: random)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET_FILE = path.join(ROOT, 'src/math.js');
const PATTERNS_FILE = path.join(ROOT, 'bug-patterns/patterns.json');

function loadPatterns() {
  const raw = fs.readFileSync(PATTERNS_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.patterns) || parsed.patterns.length === 0) {
    throw new Error('bug-patterns/patterns.json must define a non-empty `patterns` array');
  }
  return parsed.patterns;
}

function pickPattern(patterns) {
  const forced = process.env.ARENA_PATTERN_ID;
  if (forced) {
    const match = patterns.find((p) => p.id === forced);
    if (!match) throw new Error(`forced pattern id "${forced}" not found`);
    return match;
  }
  return patterns[Math.floor(Math.random() * patterns.length)];
}

function applyPattern(pattern) {
  const before = fs.readFileSync(TARGET_FILE, 'utf8');
  if (!before.includes(pattern.find)) {
    return { applied: false, reason: 'find-text-missing' };
  }
  const after = before.replace(pattern.find, pattern.replace);
  if (after === before) {
    return { applied: false, reason: 'replace-was-noop' };
  }
  fs.writeFileSync(TARGET_FILE, after);
  return { applied: true, before, after };
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] })
    .toString()
    .trim();
}

function branchName(pattern) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `arena/bug-${pattern.id}-${ts}`;
}

function createPr(pattern, branch) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    throw new Error('GITHUB_REPOSITORY + GITHUB_TOKEN must be set');
  }
  const body = [
    `**Arena bug injection.**`,
    ``,
    `- Pattern: \`${pattern.id}\` (${pattern.category})`,
    `- Summary: ${pattern.summary}`,
    ``,
    `CI will fail on this PR. The ai-ci-fixer workflow then runs against the failure and opens a follow-up PR with the fix.`,
    ``,
    `<!-- arena-cycle-marker pattern=${pattern.id} -->`,
  ].join('\n');

  const payload = {
    title: `arena(bug): ${pattern.id}`,
    head: branch,
    base: 'main',
    body,
  };
  const res = execFileSync('curl', [
    '-sS', '-X', 'POST',
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
    `https://api.github.com/repos/${repo}/pulls`,
    '-d', JSON.stringify(payload),
  ]).toString();
  let parsed;
  try { parsed = JSON.parse(res); } catch { parsed = { raw: res }; }
  if (!parsed.html_url) {
    throw new Error(`PR creation failed: ${JSON.stringify(parsed).slice(0, 400)}`);
  }
  return parsed;
}

function main() {
  const patterns = loadPatterns();
  const pattern = pickPattern(patterns);
  console.log(`[arena] picked pattern: ${pattern.id} — ${pattern.summary}`);

  const apply = applyPattern(pattern);
  if (!apply.applied) {
    console.log(`[arena] SKIP: ${apply.reason}`);
    process.exit(0);
  }

  // git identity for the bot
  git('config', 'user.name', 'gatetest-arena[bot]');
  git('config', 'user.email', 'arena-bot@gatetest.ai');

  const branch = branchName(pattern);
  git('checkout', '-b', branch);
  git('add', 'src/math.js');
  git('commit', '-m', `arena(bug): ${pattern.id}`);
  git('push', 'origin', branch);

  const pr = createPr(pattern, branch);
  console.log(`[arena] opened PR: ${pr.html_url}`);
}

main();
