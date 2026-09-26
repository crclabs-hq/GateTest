// =============================================================================
// GITIGNORE — minimal, dependency-free gitignore parser
// =============================================================================
// Phase 6 launch hardening (gap 1 from the audit):
//
// Most modules today walk the whole tree and re-implement their own ad-hoc
// "skip node_modules" logic. The result: false positives from generated code,
// 1000s of unwanted findings against minified bundles, and scans that take
// 10x longer than they should. This parser respects every level of nested
// .gitignore plus the global negation rules (`!pattern` to un-ignore).
//
// Compatibility:
//   - Standard gitignore syntax: leading `/`, trailing `/`, `**`, `*`, `?`,
//     character classes `[abc]`, negation `!`, blank lines + `#` comments
//   - Nested .gitignore — a child `.gitignore` adds rules ONLY for paths
//     under its directory
//   - Global excludes: `.gitignore` at the repo root, plus our own
//     hardcoded base-skip list (node_modules / .git / dist / etc) which
//     is non-negotiable even when a customer's .gitignore exempts them
//
// Compiles each pattern to a regex up front so per-file checks are fast.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { repoRelative } = require('./repo-path');

const { safeReadFile } = require('./safe-fs');

// Base patterns we always skip — we treat these as if they were in a
// machine-wide .gitignore. Customer can never override (no point: scanning
// .git/HEAD generates noise nobody wants).
// One definition of what a walk skips (src/core/walk-excludes.js).
const { WALK_EXCLUDE_SET: HARD_SKIP_DIRS } = require('./walk-excludes');

/**
 * Compile one gitignore line into a regex matcher.
 * Returns { regex, negate, dirOnly } or null for blank/comment lines.
 *
 * @param {string} line — a single .gitignore line
 * @param {string} basePrefix — the directory the .gitignore lives in (relative
 *                               to repo root, slash-separated, no leading slash)
 */
function compilePattern(line, basePrefix = '') {
  let pat = line.replace(/\r$/, '');
  if (!pat || pat.startsWith('#')) return null;
  pat = pat.replace(/\\#/g, '#');
  pat = pat.trim();
  if (!pat) return null;

  let negate = false;
  if (pat.startsWith('!')) {
    negate = true;
    pat = pat.slice(1);
  }

  let dirOnly = false;
  if (pat.endsWith('/')) {
    dirOnly = true;
    pat = pat.slice(0, -1);
  }

  // Anchored patterns (start with `/`) are relative to the .gitignore's directory
  let anchored = false;
  if (pat.startsWith('/')) {
    anchored = true;
    pat = pat.slice(1);
  }
  // Patterns without a slash mid-string match anywhere in the tree (under base)
  const hasMidSlash = pat.indexOf('/') !== -1 && pat.indexOf('/') !== pat.length - 1;
  if (!hasMidSlash && !anchored) {
    // Match anywhere — rewrite to **/ prefix
    pat = '**/' + pat;
  }

  // Convert to regex
  const re = patternToRegex(pat, basePrefix);
  return { regex: re, negate, dirOnly, raw: line };
}

function patternToRegex(pat, basePrefix) {
  // Escape regex specials except for our wildcards
  let r = '';
  let i = 0;
  while (i < pat.length) {
    const ch = pat[i];
    if (ch === '*') {
      if (pat[i + 1] === '*') {
        // ** — match across slashes
        if (pat[i + 2] === '/') {
          r += '(?:.*/)?';
          i += 3;
        } else {
          r += '.*';
          i += 2;
        }
      } else {
        // * — match within a single path segment
        r += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      r += '[^/]';
      i += 1;
    } else if (ch === '[') {
      // character class — pass through, escape any backslashes
      const close = pat.indexOf(']', i + 1);
      if (close === -1) {
        r += '\\[';
        i += 1;
      } else {
        r += pat.slice(i, close + 1);
        i = close + 1;
      }
    } else if ('.+()|^$\\{}'.includes(ch)) {
      r += '\\' + ch;
      i += 1;
    } else {
      r += ch;
      i += 1;
    }
  }

  // Build the full anchored regex
  // Pattern matches if the trailing path matches `r` (file) OR a prefix
  // segment matches (directory containing files)
  const prefix = basePrefix ? basePrefix + '/' : '';
  const full = '^' + escapeRegex(prefix) + r + '(?:/.*)?$';
  return new RegExp(full);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a matcher that decides whether a path should be ignored.
 * @param {string} root — repo root (absolute)
 * @returns {(relativePath: string, isDir?: boolean) => boolean}
 */
function buildIgnoreMatcher(root) {
  // Discover all .gitignore files within the tree (cheap — bounded walk)
  const ignoreFiles = collectGitignoreFiles(root);
  const compiled = [];
  for (const igPath of ignoreFiles) {
    const r = safeReadFile(igPath, { maxBytes: 256 * 1024 });
    if (!r.ok) continue;
    const baseDir = repoRelative(root, path.dirname(igPath));
    const lines = r.content.split('\n');
    for (const line of lines) {
      const c = compilePattern(line, baseDir);
      if (c) compiled.push(c);
    }
  }

  return function matches(relativePath, isDir = false) {
    // Hard skips win — a customer can't .gitignore-negate node_modules back in
    const segs = relativePath.split('/');
    for (const seg of segs) {
      if (HARD_SKIP_DIRS.has(seg)) return true;
    }
    // Dotfiles at any depth — gitignore-style we already auto-skip dot-dirs
    // in the walker, but a stray dotfile (e.g. `.envrc`) we leave to the
    // caller's filter

    // Walk patterns in order; later (more-specific / negation) rules win
    let ignored = false;
    for (const c of compiled) {
      if (c.dirOnly && !isDir) continue;
      if (c.regex.test(relativePath)) {
        ignored = !c.negate;
      }
    }
    return ignored;
  };
}

function collectGitignoreFiles(root) {
  const out = [];
  const queue = [root];
  const skipDirs = HARD_SKIP_DIRS;

  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        if (e.name.startsWith('.') && e.name !== '.github' && e.name !== '.husky') continue;
        queue.push(path.join(dir, e.name));
      } else if (e.isFile() && e.name === '.gitignore') {
        out.push(path.join(dir, e.name));
      }
    }
  }

  return out;
}

// =============================================================================
// SCAN-SCOPE IGNORE (issue #767)
// =============================================================================
// A full scan of the AlecRae monorepo put 300 of 600 blocking findings inside
// gitignored build output (`apps/web/.next-build`, `.design`) — neither
// directory matches a HARD_SKIP_DIRS name exactly, and until now nothing in
// the default file-collection path (`BaseModule._collectFiles`) ever
// consulted a repo's .gitignore at all: `buildIgnoreMatcher` above existed
// but was wired up only behind `safe-fs.js`'s opt-in `respectGitignore`,
// which no caller passed.
//
// Two independent skip sources, both defeatable with `--include-ignored`
// (unlike HARD_SKIP_DIRS, which stays non-negotiable):
//   1. the repo's own .gitignore (root + nested, negation-aware — reusing
//      buildIgnoreMatcher above, one definition);
//   2. a built-in build-output NAME set that also matches by pattern
//      (`.next-build`, not just `.next`) so a customer's untracked or
//      differently-named build directory is still recognised even without
//      a .gitignore entry for it.
//
// Untracked-but-not-ignored files are never touched by either mechanism —
// this is pattern matching against .gitignore text, never `git status`, so
// a fresh file the developer has not committed yet keeps scanning normally.

const BUILD_OUTPUT_DIR_RE =
  /^(?:\.next(?:-.*)?|dist|build|out|coverage|\.turbo|\.cache|\.nuxt|\.svelte-kit|target)$/;

/** Is this single path SEGMENT (never a full path) a build-output dir name? */
function isBuildOutputSegment(name) {
  return BUILD_OUTPUT_DIR_RE.test(name);
}

// Files that are a public CONTRACT, never a secret: the env-vars rule reads
// them for the set of declared variables (src/modules/env-vars.js, phase 1),
// and most repos ignore `.env*` wholesale — this one does. Skipping them made
// GateTest flag its own documented variables as "missing from .env.example"
// on the first Action run after issue #767 landed (2026-09-26). They stay in
// scope regardless of .gitignore; `.env` itself (real values) stays ignored.
const ENV_CONTRACT_FILE_RE = /^\.env(?:\..+)?\.(?:example|sample|template|dist)$/;

/** Is this relative path an env contract file (`.env.example`, `.env.local.sample`, ...)? */
function isEnvContractFile(relativePath) {
  const segs = String(relativePath).replace(/\\/g, '/').split('/');
  return ENV_CONTRACT_FILE_RE.test(segs[segs.length - 1]);
}

// One switch, process-wide, set once from the CLI flag (bin/gatetest.js,
// beside the --offline precedent in src/core/offline.js) before any module
// runs. Deliberately NOT threaded through GateTestConfig/GateTestRunner
// options: gitignore-matching happens inside BaseModule._collectFiles, which
// every module calls directly, and several unrelated in-flight PRs already
// touch the options object built in bin/gatetest.js and the DEFAULT_CONFIG /
// FLAG_SPEC regions around it — a bare module-level flag avoids stacking a
// same-line collision on top of theirs.
let _includeIgnored = false;

/** Set from `--include-ignored` (or a test) — true disables both skip sources. */
function setIncludeIgnored(value) {
  _includeIgnored = Boolean(value);
}

/** Whether the current process has opted out of the gitignore/build-output skip. */
function includeIgnoredFiles() {
  return _includeIgnored;
}

// A scan walks the same tree from every module in the suite (4 to 121 of
// them) — rebuilding the .gitignore parse (its own bounded fs walk +
// per-line regex compile) that many times measured real wall-clock cost on
// AlecRae's monorepo. Cached per project root; a single CLI invocation is a
// single process scanning a .gitignore that does not change mid-run, so no
// invalidation beyond "new root, new cache entry" is needed.
const _scanMatcherCache = new Map();

/**
 * The combined "is this path out of scope for a default scan" matcher:
 * the repo's .gitignore (nested + negation, via buildIgnoreMatcher) OR the
 * built-in build-output name set. Callers check directories at descent time
 * (isDir=true) as well as individual files — a dir-only .gitignore rule
 * (`.next-build/`) only matches when isDir is true (see compilePattern), so
 * skipping the directory-level check would silently rescan everything under
 * it via the file branch alone.
 *
 * @param {string} root — repo root (absolute)
 * @returns {(relativePath: string, isDir?: boolean) => boolean}
 */
function getScanIgnoreMatcher(root) {
  const cached = _scanMatcherCache.get(root);
  if (cached) return cached;
  const gitignoreMatches = buildIgnoreMatcher(root);
  const matcher = function isIgnoredForScan(relativePath, isDir = false) {
    if (!isDir && isEnvContractFile(relativePath)) return false;
    if (gitignoreMatches(relativePath, isDir)) return true;
    const segs = String(relativePath).replace(/\\/g, '/').split('/');
    return segs.some(isBuildOutputSegment);
  };
  _scanMatcherCache.set(root, matcher);
  return matcher;
}

/** Test-only: drop cached matchers so a fixture root can be rebuilt. */
function clearScanIgnoreMatcherCache() {
  _scanMatcherCache.clear();
}

/**
 * Count every file under `root` that the default scan would skip (gitignore
 * match or built-in build-output name), for the console/JSON summary — one
 * real second walk, done ONCE per scan (not once per module, which would
 * multiply the reported number by however many modules ran).
 *
 * @param {string} root
 * @returns {number}
 */
function countIgnoredFiles(root) {
  const matcher = getScanIgnoreMatcher(root);

  let count = 0;
  const countAllFilesUnder = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (HARD_SKIP_DIRS.has(e.name)) continue;
        countAllFilesUnder(full);
      } else if (e.isFile()) {
        count += 1;
      }
    }
  };

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = repoRelative(root, full);
      if (e.isDirectory()) {
        // Hard skips (node_modules, .git, ...) are never counted here — they
        // are a separate, always-on mechanism, not a gitignore/build-output
        // finding this feature surfaces.
        if (HARD_SKIP_DIRS.has(e.name)) continue;
        if (matcher(rel, true)) {
          countAllFilesUnder(full);
          continue;
        }
        walk(full);
      } else if (e.isFile()) {
        if (matcher(rel, false)) count += 1;
      }
    }
  };
  walk(root);
  return count;
}

module.exports = {
  HARD_SKIP_DIRS,
  compilePattern,
  buildIgnoreMatcher,
  collectGitignoreFiles,
  BUILD_OUTPUT_DIR_RE,
  isBuildOutputSegment,
  setIncludeIgnored,
  includeIgnoredFiles,
  isEnvContractFile,
  getScanIgnoreMatcher,
  clearScanIgnoreMatcherCache,
  countIgnoredFiles,
};
