#!/usr/bin/env node
'use strict';
/**
 * generate-changelog.js — the structured source behind /changelog.
 *
 * docs/HISTORY.md is prose, written after the fact, and a prose changelog
 * drifts the way every hand-typed count in this repo has drifted. The
 * record that cannot drift is the main branch itself: every change reaches
 * customers as a first-parent commit on main, almost always a pull-request
 * merge. This script reads that history and writes
 * website/app/data/changelog.json, which the page imports at build time —
 * the same contract as site-stats.json and precision.json (Doctrine §7:
 * generated over typed).
 *
 * Per entry: the commit, its date, the PR number and title (from the merge
 * commit or the squash subject), which areas of the repo it touched (from
 * the first-parent diff, counted by file), which engine modules it touched
 * (mapped through src/core/registry.js — the one definition of module →
 * file), and the package.json version at that commit, so a version bump is
 * a fact on the entry that carried it rather than a date typed beside it.
 *
 * Direct commits to main are entries too (pr: null). Leaving them out would
 * make the page say "everything goes through a PR" when it does not.
 *
 * GT-04 (outside reviewer, 2026-09-26): the changelog was publishing internal
 * handoff/board churn verbatim ("docs(handoff): ... fixer does not fix",
 * "stale arena PRs for the owner") — copy written for the team, not customers.
 * `isChangelogWorthy` filters those out (see below) before the file is
 * written; the exclusion is by title pattern or by an entry touching nothing
 * but docs, and is always overridden when the entry carries an
 * engine/website/integrations/corpus change, so a real product change never
 * disappears because of how its commit happened to be titled.
 *
 * Usage:
 *   node scripts/generate-changelog.js                 # write the JSON
 *   node scripts/generate-changelog.js --dry-run       # print, don't write
 *   node scripts/generate-changelog.js --if-full-history
 *        # website prebuild: skip silently on a shallow clone instead of
 *        # overwriting a good file with a one-commit history
 *   --repo <dir> --out <file> --ref <ref> --limit <n>   # tests and CI
 *
 * The file is written one entry per line: a nightly regeneration then diffs
 * as a few lines added at the top, and a 150-entry log stays far below the
 * per-file ceiling prSize holds every diff to — a 2,600-line pretty-printed
 * blob was the first thing our own gate blocked.
 *
 * Read-only on the repository; the only file it writes is the JSON.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'website', 'app', 'data', 'changelog.json');
const DEFAULT_LIMIT = 150;

// One home for "which directory is which area" — the page shows these
// labels verbatim, and the sync test checks every entry uses one of them.
const AREAS = ['engine', 'website', 'integrations', 'ci', 'tests', 'corpus', 'tooling', 'docs', 'other'];

function areaOf(file) {
  const top = file.split('/')[0];
  if (top === 'src' || top === 'bin') return 'engine';
  if (top === 'website') return 'website';
  if (top === 'integrations' || file === 'action.yml') return 'integrations';
  if (top === '.github') return 'ci';
  if (top === 'tests') return 'tests';
  if (top === 'reliability-corpus') return 'corpus';
  if (top === 'scripts') return 'tooling';
  if (top === 'docs' || /\.md$/i.test(file)) return 'docs';
  return 'other';
}

/** module name → file stem, read from the registry source (its one home). */
function moduleFileIndex() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'registry.js'), 'utf8');
  const byStem = {};
  for (const m of src.matchAll(/^\s*(\w+):\s*'\.\.\/modules\/([\w-]+)\.js'/gm)) byStem[m[2]] = m[1];
  return byStem;
}

function parseArgs(argv) {
  const opts = { repo: ROOT, out: DEFAULT_OUT, ref: 'HEAD', limit: DEFAULT_LIMIT, dryRun: false, ifFullHistory: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--if-full-history') opts.ifFullHistory = true;
    else if (a === '--repo') opts.repo = path.resolve(argv[++i]);
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--ref') opts.ref = argv[++i];
    else if (a === '--limit') opts.limit = Number(argv[++i]) || DEFAULT_LIMIT;
  }
  return opts;
}

// No shell, fixed argv — nothing is interpolated into a command line.
function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}

const MERGE_RE = /^Merge pull request #(\d+) from \S+/;
const SQUASH_RE = /^(.*?)\s*\(#(\d+)\)$/;

// Titles that are internal process notes, not product changes — never
// customer copy, whatever area they happen to touch by title alone.
const EXCLUDE_TITLE_RES = [
  /^docs\(handoff\)/i,
  /^docs\(board\)/i,
  /^docs\(launch-board\)/i,
  /^chore\(stats\)/i,
  /^chore\(trainer\)/i,
  /^merge branch/i,
];

// An entry that touches one of these areas is a real product change and
// ships regardless of what its title says (Doctrine: the code, not the
// commit message, is the fact).
const SUBSTANTIVE_AREAS = ['engine', 'website', 'integrations', 'corpus'];

/** Does this entry belong in the public changelog? (GT-04) */
function isChangelogWorthy(entry) {
  const areaKeys = Object.keys(entry.areas);
  if (areaKeys.some((a) => SUBSTANTIVE_AREAS.includes(a))) return true;
  if (EXCLUDE_TITLE_RES.some((re) => re.test(entry.title))) return false;
  const onlyDocs = areaKeys.length === 1 && areaKeys[0] === 'docs';
  if (onlyDocs) return false;
  return true;
}

/** The PR number and title a first-parent commit carries, in either shape. */
function describeCommit(subject, body) {
  const merge = MERGE_RE.exec(subject);
  if (merge) {
    const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || subject;
    return { pr: Number(merge[1]), title: firstLine };
  }
  const squash = SQUASH_RE.exec(subject);
  if (squash) return { pr: Number(squash[2]), title: squash[1] };
  return { pr: null, title: subject };
}

function readCommits(repo, ref, limit) {
  const raw = git(repo, ['log', '--first-parent', `--max-count=${limit}`, '--date=short',
    '--format=%H%x1f%ad%x1f%s%x1f%b%x1e', ref]);
  return raw.split('\x1e').map((s) => s.replace(/^\n/, '')).filter((s) => s.trim())
    .map((rec) => {
      const [sha, date, subject, body = ''] = rec.split('\x1f');
      return { sha, date, subject, body };
    });
}

function changedFiles(repo, sha) {
  try {
    // First-parent diff: for a merge, what the PR brought in; for a plain
    // commit, the commit itself. A root commit has no parent → whole tree.
    return git(repo, ['diff-tree', '--no-commit-id', '-r', '--name-only', '-m', '--first-parent', sha])
      .split('\n').filter(Boolean);
  } catch { return []; }
}

function versionAt(repo, sha) {
  try { return JSON.parse(git(repo, ['show', `${sha}:package.json`])).version || null; }
  catch { return null; }
}

function buildEntry(repo, commit, byStem) {
  const files = changedFiles(repo, commit.sha);
  const counts = {};
  const modules = new Set();
  for (const f of files) {
    const a = areaOf(f);
    counts[a] = (counts[a] || 0) + 1;
    const m = /^src\/modules\/([\w-]+)\.js$/.exec(f);
    if (m && byStem[m[1]]) modules.add(byStem[m[1]]);
  }
  const areas = Object.entries(counts).sort((x, y) => y[1] - x[1] || AREAS.indexOf(x[0]) - AREAS.indexOf(y[0]));
  const { pr, title } = describeCommit(commit.subject, commit.body);
  return {
    sha: commit.sha,
    short: commit.sha.slice(0, 7),
    date: commit.date,
    pr,
    title,
    area: areas.length ? areas[0][0] : 'other',
    areas: Object.fromEntries(areas),
    files: files.length,
    modules: [...modules].sort(),
    packageVersion: versionAt(repo, commit.sha),
  };
}

function generate(opts) {
  const byStem = moduleFileIndex();
  const commits = readCommits(opts.repo, opts.ref, opts.limit);
  const allEntries = commits.map((c) => buildEntry(opts.repo, c, byStem));
  // A version is a fact on the entry that changed it: compare with the
  // next-older entry (the last one has nothing older in range → no marker).
  // This runs over every commit, before filtering, so a bump landing on a
  // filtered-out commit (e.g. a docs-only release note) is never lost or
  // misattributed to the wrong surviving neighbour.
  for (let i = 0; i < allEntries.length; i++) {
    const older = allEntries[i + 1];
    const bumped = older && allEntries[i].packageVersion && allEntries[i].packageVersion !== older.packageVersion;
    allEntries[i].version = bumped ? allEntries[i].packageVersion : null;
    delete allEntries[i].packageVersion;
  }
  const entries = allEntries.filter(isChangelogWorthy);
  return {
    source: 'scripts/generate-changelog.js',
    generatedAt: new Date().toISOString(),
    ref: opts.ref,
    head: entries.length ? entries[0].sha : null,
    // The repo's actual current version, independent of filtering — the true
    // tip of history, not just the newest entry that made the public cut.
    currentVersion: commits.length ? versionAt(opts.repo, commits[0].sha) : null,
    limit: opts.limit,
    areas: AREAS,
    entries,
  };
}

function isShallow(repo) {
  try { return git(repo, ['rev-parse', '--is-shallow-repository']).trim() === 'true'; }
  catch { return true; }
}

/** Header fields pretty-printed, entries one per line. */
function serialize(data) {
  const { entries, ...head } = data;
  const headJson = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  const rows = entries.map((e) => `    ${JSON.stringify(e)}`).join(',\n');
  return `${headJson},\n  "entries": [\n${rows}\n  ]\n}\n`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (isShallow(opts.repo)) {
    // A shallow clone would produce a changelog that ends where the clone
    // was cut and says nothing about it (Doctrine §1). The prebuild keeps
    // the committed file; anything else is told to fetch the history.
    if (opts.ifFullHistory) {
      process.stderr.write('generate-changelog: shallow clone — keeping the committed changelog.json\n');
      return;
    }
    throw new Error('this clone is shallow; run `git fetch --unshallow` first or pass --if-full-history');
  }
  const data = generate(opts);
  const json = serialize(data);
  if (opts.dryRun) { process.stdout.write(json); return; }
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, json);
  process.stderr.write(`generate-changelog: ${data.entries.length} entries → ${path.relative(process.cwd(), opts.out)}\n`);
}

if (require.main === module) {
  try { main(); } catch (err) {
    process.stderr.write(`generate-changelog: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { serialize, describeCommit, areaOf, AREAS, isChangelogWorthy };
