#!/usr/bin/env node
/**
 * gatetest train — run all flywheel trainers locally.
 *
 * Wave 1-4 ships five trainers under website/app/lib/trainers/:
 *   1. pattern-miner            corpus → recurring patterns + recommendations
 *   2. recipe-promoter          recurring patterns → recipe proposals
 *   3. regression-test-generator under-tested modules → pending tests
 *   4. adversarial-mutator      mutate-then-rescan to find coverage holes
 *   5. cross-repo-promoter      anonymise proposals into shared corpus vectors
 *
 * This CLI is the on-laptop convenience runner. Same logic as the nightly
 * GitHub Action workflow (trainer-nightly.yml) but emits human-readable
 * markdown to stdout and lets developers run trainers ad-hoc.
 *
 * USAGE:
 *   gatetest train                  Run all 5 trainers, print summary.
 *   gatetest train --only pattern   Run just one (substring match: pattern,
 *                                   recipe, regression, adversarial, cross).
 *   gatetest train --json           Emit a combined JSON report instead of
 *                                   per-trainer markdown.
 *   gatetest train --no-ingest      Skip the git-history ingestion step.
 *   gatetest train --no-adversarial Skip adversarial-mutator (it can take
 *                                   minutes; useful in tight feedback loops).
 *
 * Trainer outputs land at ~/.gatetest/trainers/<name>-latest.json.
 *
 * EXIT CODES:
 *   0  all trainers ran (even if individual trainers flag issues)
 *   1  fatal error before any trainer could start
 */

'use strict';

const path = require('path');

const TRAINERS = [
  { name: 'pattern-miner',
    flag: 'pattern',
    modulePath: '../website/app/lib/trainers/pattern-miner.js',
    method: 'mine' },
  { name: 'recipe-promoter',
    flag: 'recipe',
    modulePath: '../website/app/lib/trainers/recipe-promoter.js',
    method: 'propose' },
  { name: 'recipe-auto-promoter',
    flag: 'auto-promote',
    modulePath: '../website/app/lib/trainers/recipe-auto-promoter.js',
    method: 'autoPromote' },
  { name: 'regression-test-generator',
    flag: 'regression',
    modulePath: '../website/app/lib/trainers/regression-test-generator.js',
    method: 'generate' },
  { name: 'cross-repo-promoter',
    flag: 'cross',
    modulePath: '../website/app/lib/trainers/cross-repo-promoter.js',
    method: 'promote' },
  { name: 'confidence-calibrator',
    flag: 'confidence',
    modulePath: '../website/app/lib/trainers/confidence-calibrator.js',
    method: 'calibrate' },
  { name: 'adversarial-mutator',
    flag: 'adversarial',
    modulePath: '../website/app/lib/trainers/adversarial-mutator.js',
    method: 'run',
    slow: true },
];

function parseTrainArgs(argv) {
  const opts = {
    only: null,
    json: false,
    noIngest: false,
    noAdversarial: false,
    help: false,
    repoRoot: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--no-ingest') opts.noIngest = true;
    else if (a === '--no-adversarial') opts.noAdversarial = true;
    else if (a === '--only') opts.only = argv[++i] || null;
    else if (a === '--repo') opts.repoRoot = path.resolve(argv[++i] || '.');
  }
  return opts;
}

function printHelp() {
  process.stdout.write([
    'gatetest train — run all flywheel trainers locally',
    '',
    'OPTIONS',
    '  --only <name>       run a single trainer by substring (pattern, recipe,',
    '                      regression, adversarial, cross)',
    '  --json              emit combined JSON instead of per-trainer markdown',
    '  --no-ingest         skip session-fix git-history ingestion',
    '  --no-adversarial    skip adversarial-mutator (slow)',
    '  --repo <path>       run against a different repo root',
    '  -h, --help          show this',
    '',
    'Trainer outputs land at ~/.gatetest/trainers/<name>-latest.json',
    '',
  ].join('\n'));
}

async function ingestSessionFixes(repoRoot) {
  try {
    // eslint-disable-next-line global-require
    const ST = require('../website/app/lib/session-telemetry.js');
    const stats = ST.ingestGitHistory({ repoRoot, since: '30 days ago' });
    return { ok: true, stats };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

async function runTrainer(t, opts) {
  let mod;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    mod = require(t.modulePath);
  } catch (err) {
    return {
      name: t.name,
      ok: false,
      error: `failed to load module: ${err.message}`,
    };
  }
  const method = mod[t.method];
  if (typeof method !== 'function') {
    return {
      name: t.name,
      ok: false,
      error: `module missing ${t.method}() — contract violation`,
    };
  }
  const startedAt = Date.now();
  try {
    const arg = (t.name === 'adversarial-mutator') ? { repoRoot: opts.repoRoot, suite: 'quick' } : { repoRoot: opts.repoRoot };
    const result = await method(arg);
    return {
      name: t.name,
      ok: true,
      durationMs: Date.now() - startedAt,
      result,
      renderMarkdown: typeof mod.renderMarkdown === 'function' ? mod.renderMarkdown(result) : null,
    };
  } catch (err) {
    return {
      name: t.name,
      ok: false,
      error: err && err.message,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function main(argv = []) {
  const opts = parseTrainArgs(argv);
  if (opts.help) {
    printHelp();
    return 0;
  }

  const summary = {
    startedAt: new Date().toISOString(),
    repoRoot: opts.repoRoot,
    ingestion: null,
    trainers: [],
  };

  if (!opts.noIngest) {
    process.stderr.write('[train] ingesting git history into session-fix corpus…\n');
    summary.ingestion = await ingestSessionFixes(opts.repoRoot);
  }

  const selected = TRAINERS.filter((t) => {
    if (opts.noAdversarial && t.flag === 'adversarial') return false;
    if (opts.only && !t.flag.toLowerCase().includes(opts.only.toLowerCase()) && !t.name.toLowerCase().includes(opts.only.toLowerCase())) return false;
    return true;
  });

  for (const t of selected) {
    process.stderr.write(`[train] running ${t.name}${t.slow ? ' (slow — may take 1-5 minutes)' : ''}…\n`);
    const trainerResult = await runTrainer(t, opts);
    summary.trainers.push(trainerResult);
    if (!opts.json && trainerResult.renderMarkdown) {
      process.stdout.write(trainerResult.renderMarkdown + '\n\n---\n\n');
    } else if (!opts.json && trainerResult.ok) {
      process.stdout.write(`# ${trainerResult.name}\n\n_(no renderMarkdown — see JSON)_\n\n---\n\n`);
    } else if (!opts.json && !trainerResult.ok) {
      process.stdout.write(`# ${trainerResult.name} — FAILED\n\n${trainerResult.error}\n\n---\n\n`);
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    const ran = summary.trainers.length;
    const ok = summary.trainers.filter((t) => t.ok).length;
    process.stdout.write(`\n# Summary\n\n${ok}/${ran} trainers completed successfully.\n`);
    if (ran > ok) {
      process.stdout.write('\nFailed trainers:\n');
      for (const t of summary.trainers.filter((x) => !x.ok)) {
        process.stdout.write(`  - ${t.name}: ${t.error}\n`);
      }
    }
  }

  return 0;
}

module.exports = { main, parseTrainArgs, TRAINERS };

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[train] fatal: ${err && err.message}\n`);
      process.exit(1);
    });
}
