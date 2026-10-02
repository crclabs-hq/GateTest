#!/usr/bin/env node
'use strict';

/**
 * PR overlap check — the CI backstop for work claims (scripts/work-claims.js).
 *
 * Leases are the agreement; this is what still holds if an actor forgets to
 * take one. On every pull request it compares the files this PR changes with
 * every other open PR:
 *   - a medic PR (branch `medic/…`) that overlaps an open session PR FAILS —
 *     the medic yields to work a person or session already has open;
 *   - a session PR that overlaps an open medic PR passes with a warning that
 *     names the medic PR, so the overlap is visible in the checks list;
 *   - no overlap passes.
 * If the GitHub API cannot be read the check says "not checked" and passes
 * with a warning: a backstop that blocks merges on an API blip would make
 * the gate the bottleneck (Forbidden #25), and the lease is the primary rule.
 *
 * Env (set by the workflow): GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER.
 */

const MEDIC_PREFIX = 'medic/';

/** 'medic' or 'session', from the branch name (one definition). */
function actorOf(branch) {
  return String(branch || '').startsWith(MEDIC_PREFIX) ? 'medic' : 'session';
}

/**
 * Pure. `self` and `others` are { number, branch, files: string[] }.
 * Returns { verdict: 'pass'|'warn'|'fail', overlaps: [{ number, actor, files }] }.
 */
function judge(self, others) {
  const mine = new Set(self.files);
  const selfActor = actorOf(self.branch);
  const overlaps = [];
  for (const o of others) {
    if (o.number === self.number) continue;
    const shared = o.files.filter((f) => mine.has(f));
    if (shared.length) overlaps.push({ number: o.number, actor: actorOf(o.branch), files: shared.sort() });
  }
  const againstSession = overlaps.filter((o) => o.actor === 'session');
  const againstMedic = overlaps.filter((o) => o.actor === 'medic');
  if (selfActor === 'medic' && againstSession.length) return { verdict: 'fail', overlaps };
  if (againstMedic.length || overlaps.length) return { verdict: 'warn', overlaps };
  return { verdict: 'pass', overlaps };
}

async function gh(path, token, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`https://api.github.com/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
  return res.json();
}

async function prFiles(repo, number, token, fetchImpl) {
  const files = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await gh(`repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, token, fetchImpl);
    files.push(...batch.map((f) => f.filename));
    if (batch.length < 100) break;
  }
  return files;
}

async function main(env = process.env, fetchImpl = globalThis.fetch) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, PR_NUMBER } = env;
  const number = Number(PR_NUMBER);
  if (!token || !repo || !number) {
    process.stdout.write('::warning title=work claims::not checked — GITHUB_TOKEN, GITHUB_REPOSITORY or PR_NUMBER missing\n');
    return 0;
  }
  let self;
  const others = [];
  try {
    const open = await gh(`repos/${repo}/pulls?state=open&per_page=100`, token, fetchImpl);
    for (const pr of open) {
      const entry = { number: pr.number, branch: pr.head && pr.head.ref, files: await prFiles(repo, pr.number, token, fetchImpl) };
      if (pr.number === number) self = entry; else others.push(entry);
    }
    if (!self) {
      const pr = await gh(`repos/${repo}/pulls/${number}`, token, fetchImpl);
      self = { number, branch: pr.head && pr.head.ref, files: await prFiles(repo, number, token, fetchImpl) };
    }
  } catch (err) {
    process.stdout.write(`::warning title=work claims::not checked — ${err.message}\n`);
    return 0;
  }
  const { verdict, overlaps } = judge(self, others);
  const lines = overlaps.map((o) => `#${o.number} (${o.actor}): ${o.files.slice(0, 8).join(', ')}${o.files.length > 8 ? ` … +${o.files.length - 8}` : ''}`);
  if (verdict === 'fail') {
    process.stdout.write(`::error title=work claims::medic PR overlaps open session work — the medic yields. ${lines.join(' | ')}\n`);
    return 1;
  }
  if (verdict === 'warn') {
    process.stdout.write(`::warning title=work claims::overlaps other open PRs — coordinate before merging. ${lines.join(' | ')}\n`);
    return 0;
  }
  process.stdout.write(`work claims: #${number} (${actorOf(self.branch)}) overlaps no open PR\n`);
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    process.stdout.write(`::warning title=work claims::not checked — ${err && err.message ? err.message : err}\n`);
    process.exitCode = 0;
  });
}

module.exports = { actorOf, judge, main, MEDIC_PREFIX };
