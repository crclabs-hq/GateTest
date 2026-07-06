'use strict';

/**
 * Regression bisector — read-only git blame/log helpers that answer
 * "which commit introduced this line, and why" without ever checking
 * out or mutating the working tree (no `git bisect`, no `git checkout`).
 *
 * Shared core engine for both the CLI (`gatetest blame`) and the MCP
 * `blame_regression` tool — one implementation, two entry points.
 * Lives in src/core/, not src/modules/, so it never registers as a scan
 * module and never touches the paid scan+fix engine.
 */

const { execFileSync } = require('child_process');

function runGit(args, cwd) {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr).trim() : '';
    return { ok: false, error: stderr || (err && err.message) || String(err) };
  }
}

function isGitRepo(cwd) {
  const res = runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  return res.ok && res.stdout.trim() === 'true';
}

// ---------------------------------------------------------------------------
// Porcelain blame parsing.
// ---------------------------------------------------------------------------

const HEADER_RE = /^([0-9a-f]{40})\s+\d+\s+(\d+)(?:\s+\d+)?$/;

function parsePorcelainBlame(output) {
  const lines = output.split('\n');
  const headerMatch = lines[0] && lines[0].match(/^([0-9a-f]{40})\s/);
  if (!headerMatch) return null;

  const hash = headerMatch[1];
  let author = null;
  let authorEmail = null;
  let authorTime = null;
  let summary = null;
  let content = '';

  for (const l of lines.slice(1)) {
    if (l.startsWith('author ')) author = l.slice('author '.length);
    else if (l.startsWith('author-mail ')) authorEmail = l.slice('author-mail '.length).replace(/^<|>$/g, '');
    else if (l.startsWith('author-time ')) authorTime = parseInt(l.slice('author-time '.length), 10);
    else if (l.startsWith('summary ')) summary = l.slice('summary '.length);
    else if (l.startsWith('\t')) content = l.slice(1);
  }

  return {
    hash,
    shortHash: hash.slice(0, 8),
    author,
    authorEmail,
    date: Number.isFinite(authorTime) ? new Date(authorTime * 1000).toISOString() : null,
    summary,
    lineContent: content,
  };
}

/**
 * Multi-line porcelain output repeats full metadata only the first time a
 * commit is seen; later lines from the same commit show just the header +
 * a content line. Metadata is accumulated per-hash across the output.
 */
function parsePorcelainBlameMulti(output) {
  const lines = output.split('\n');
  const commits = new Map();
  const records = [];
  let i = 0;

  while (i < lines.length) {
    const m = lines[i].match(HEADER_RE);
    if (!m) { i++; continue; }
    const hash = m[1];
    const finalLine = parseInt(m[2], 10);
    i++;

    const meta = commits.get(hash) || {};
    let content = '';
    let gotContent = false;
    while (i < lines.length && !gotContent) {
      const l = lines[i];
      if (HEADER_RE.test(l)) break;
      if (l.startsWith('author ')) meta.author = l.slice('author '.length);
      else if (l.startsWith('author-mail ')) meta.authorEmail = l.slice('author-mail '.length).replace(/^<|>$/g, '');
      else if (l.startsWith('author-time ')) meta.authorTime = parseInt(l.slice('author-time '.length), 10);
      else if (l.startsWith('summary ')) meta.summary = l.slice('summary '.length);
      else if (l.startsWith('\t')) { content = l.slice(1); gotContent = true; }
      i++;
    }
    commits.set(hash, meta);
    records.push({ hash, finalLine, lineContent: content });
  }

  return { commits, records };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function blameLine({ cwd, file, line }) {
  if (!isGitRepo(cwd)) return { ok: false, reason: `${cwd} is not inside a git repository` };
  if (!file || typeof line !== 'number' || line < 1) {
    return { ok: false, reason: 'file and a 1-based line number are required' };
  }
  const res = runGit(['blame', '-L', `${line},${line}`, '--porcelain', '--', file], cwd);
  if (!res.ok) return { ok: false, reason: res.error };
  const parsed = parsePorcelainBlame(res.stdout);
  if (!parsed) return { ok: false, reason: 'could not parse git blame output (file may be untracked or line out of range)' };
  return { ok: true, file, line, ...parsed };
}

function blameRange({ cwd, file, startLine, endLine }) {
  if (!isGitRepo(cwd)) return { ok: false, reason: `${cwd} is not inside a git repository` };
  if (!file || typeof startLine !== 'number' || typeof endLine !== 'number' || startLine < 1 || endLine < startLine) {
    return { ok: false, reason: 'file, startLine, and endLine (>= startLine) are required' };
  }
  const res = runGit(['blame', '-L', `${startLine},${endLine}`, '--porcelain', '--', file], cwd);
  if (!res.ok) return { ok: false, reason: res.error };

  const { commits, records } = parsePorcelainBlameMulti(res.stdout);
  if (records.length === 0) return { ok: false, reason: 'could not parse git blame output for this range' };

  const counts = new Map();
  for (const r of records) counts.set(r.hash, (counts.get(r.hash) || 0) + 1);

  const rankedCommits = [...counts.entries()]
    .map(([hash, lineCount]) => {
      const meta = commits.get(hash) || {};
      return {
        hash,
        shortHash: hash.slice(0, 8),
        lineCount,
        author: meta.author || null,
        authorEmail: meta.authorEmail || null,
        date: Number.isFinite(meta.authorTime) ? new Date(meta.authorTime * 1000).toISOString() : null,
        summary: meta.summary || null,
      };
    })
    .sort((a, b) => b.lineCount - a.lineCount || String(b.date).localeCompare(String(a.date)));

  return { ok: true, file, startLine, endLine, distinctCommits: rankedCommits.length, commits: rankedCommits, lines: records };
}

function showCommit({ cwd, hash, maxDiffBytes = 6000 }) {
  if (!isGitRepo(cwd)) return { ok: false, reason: `${cwd} is not inside a git repository` };
  if (!hash) return { ok: false, reason: 'hash is required' };

  const metaRes = runGit(['show', '-s', '--format=%H%n%an%n%ae%n%aI%n%s%n%b', hash], cwd);
  if (!metaRes.ok) return { ok: false, reason: metaRes.error };
  const [fullHash, author, authorEmail, dateIso, subject, ...bodyLines] = metaRes.stdout.split('\n');

  const statRes = runGit(['show', '--stat', '--format=', hash], cwd);
  const diffRes = runGit(['show', '--format=', hash], cwd);

  let diff = diffRes.ok ? diffRes.stdout : '';
  let truncated = false;
  if (diff.length > maxDiffBytes) {
    diff = diff.slice(0, maxDiffBytes);
    truncated = true;
  }

  return {
    ok: true,
    hash: fullHash,
    shortHash: fullHash.slice(0, 8),
    author,
    authorEmail,
    date: dateIso,
    message: [subject, ...bodyLines].join('\n').trim(),
    stat: statRes.ok ? statRes.stdout.trim() : null,
    diff,
    truncated,
  };
}

/**
 * Given multiple { file, line } hits (e.g. every frame of a resolved stack
 * trace, or every location a scan finding touched), blame each one and rank
 * candidate commits by how many hits they explain — the commit touching the
 * most hits is the most likely single regression cause.
 */
function findLikelyRegressionCommit({ cwd, hits }) {
  if (!Array.isArray(hits) || hits.length === 0) {
    return { ok: false, reason: 'hits must be a non-empty array of { file, line }' };
  }

  const perHit = [];
  const tally = new Map();

  for (const h of hits) {
    const res = blameLine({ cwd, file: h.file, line: h.line });
    perHit.push({ file: h.file, line: h.line, blame: res });
    if (res.ok) {
      const entry = tally.get(res.hash) || { count: 0, files: new Set(), meta: res };
      entry.count += 1;
      entry.files.add(h.file);
      tally.set(res.hash, entry);
    }
  }

  const candidates = [...tally.entries()]
    .map(([hash, e]) => ({
      hash,
      shortHash: hash.slice(0, 8),
      hitCount: e.count,
      fileCount: e.files.size,
      files: [...e.files],
      author: e.meta.author,
      authorEmail: e.meta.authorEmail,
      date: e.meta.date,
      summary: e.meta.summary,
    }))
    .sort((a, b) => b.hitCount - a.hitCount || String(b.date).localeCompare(String(a.date)));

  return { ok: true, perHit, candidates };
}

module.exports = {
  isGitRepo,
  blameLine,
  blameRange,
  showCommit,
  findLikelyRegressionCommit,
  parsePorcelainBlame,
  parsePorcelainBlameMulti,
};
