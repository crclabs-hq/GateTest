/**
 * PR-Quality Coach Module.
 *
 * `prSize` blocks PRs that are too BIG to review. `prQuality` flags PRs
 * that are the WRONG SHAPE — bad commit messages, source changes without
 * matching tests, dependency churn that ought to be in its own PR.
 * Together they form a hygiene gate that teaches the team to ship better,
 * not just smaller.
 *
 * Inputs: git history on the current branch vs the base ref, resolved by
 * the ONE base-ref definition (Doctrine §4) — `src/core/diff-base.js`'s
 * `resolveDiffBase()`, the same helper `prSize` uses. That resolver returns
 * a merge-base, not a raw ref: diffing `<mergeBase>..HEAD` counts only what
 * THIS branch introduced. A prior version of this module resolved a raw
 * ref (`origin/main`, etc.) and diffed `<ref>..HEAD` directly — a plain
 * two-dot diff, not a merge-base — so once `origin/main` advanced past the
 * branch point (the ordinary case in any active repo, and exactly what a
 * `pull_request` checkout sees once other PRs have merged), the diff
 * against the moved base surfaced files that had changed on `main` after
 * the branch forked but were simply absent from the branch, inflating the
 * counted "source files" and misfiring `pr-quality:no-tests` on PRs that
 * added nothing but tests (#561, #590). Fixed 2026-09-16.
 *
 * Rules:
 *
 *   error:   any commit on the branch has an empty / whitespace-only
 *            message. Git rejects truly empty messages, but `wip`,
 *            `.`, `fix`, single-word fly-by titles still tell the
 *            reviewer nothing.
 *            (rule: `pr-quality:empty-message:<sha>`)
 *
 *   warning: a commit's subject is shorter than 8 chars or contains
 *            only "wip"/"tmp"/"foo"/"asdf" placeholder noise.
 *            (rule: `pr-quality:weak-message:<sha>`)
 *
 *   warning: source-file changes outnumber test-file changes 5:1 or
 *            more on a PR that touches at least 3 source files. The
 *            classic "I'll add tests later" anti-pattern.
 *            (rule: `pr-quality:no-tests`)
 *
 *   warning: package.json / requirements.txt / Cargo.toml / etc.
 *            changed AND non-dep files changed. Mixed concerns —
 *            dependency upgrades should be their own PR so they
 *            can be reverted independently.
 *            (rule: `pr-quality:mixed-deps-and-code`)
 *
 *   info:    summary: total commits / commits-with-good-messages /
 *            source/test file ratio.
 *
 * "Is this a test file?" is the ONE canonical predicate (Doctrine §4,
 * `src/core/test-paths.js`, exposed as `this._isTestPath()` via
 * BaseModule) — this module used to carry its own private
 * `TEST_PATH_PATTERNS` array, which is exactly the kind of second
 * definition that drifts. Lockfile exclusion has no canonical home
 * (it's local to the "dep change" detection): a dependabot bump that
 * only touches package-lock.json doesn't fire mixed-concerns.
 *
 * When the diff itself can't be determined (git failed, not merely
 * "nothing changed"), the source/test-ratio and mixed-deps checks report
 * `pr-quality:no-tests:not-checked` (three-state, Doctrine §1) instead of
 * silently treating zero changed files as a clean PR.
 *
 * Module ID: 91. Suite: full / scan_fix / nuclear (informational —
 * never blocks, but appears in every paid scan).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');
const { resolveDiffBase } = require('../core/diff-base');

const DEFAULT_CONFIG = {
  minSubjectLength: 8,
  weakMessagePatterns: [
    /^wip\b/i,
    /^tmp\b/i,
    /^foo\b/i,
    /^asdf\b/i,
    /^test\b/i,           // "test" / "test commit"
    /^\.+$/,              // "."
    /^fix$/i,             // bare "fix" with no detail
    /^update$/i,
    /^changes$/i,
  ],
  // Source-to-test ratio above this number triggers no-tests warning.
  // 5 = a PR that touches 5+ source files without a single test edit fires.
  maxSourceTestRatio: 5,
  // Minimum source-file count before no-tests kicks in. Tiny PRs (1-2 files)
  // often don't NEED matching tests; the warning is for genuinely sized changes.
  minSourceFilesForTestCheck: 3,
};

const DEP_MANIFEST_PATTERNS = [
  /(^|\/)package\.json$/,
  /(^|\/)requirements\.txt$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)Pipfile$/,
  /(^|\/)go\.mod$/,
  /(^|\/)Cargo\.toml$/,
  /(^|\/)Gemfile$/,
  /(^|\/)composer\.json$/,
  /(^|\/)pom\.xml$/,
  /(^|\/)build\.gradle(\.kts)?$/,
];

const LOCKFILE_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)flake\.lock$/,
];

function matchesAny(filePath, patterns) {
  for (const p of patterns) if (p.test(filePath)) return true;
  return false;
}

class PrQualityModule extends BaseModule {
  constructor() {
    super('prQuality', 'PR-quality coach — flags weak commit messages, missing tests, mixed deps+code');
  }

  async run(result, config) {
    const projectRoot = (config && config.projectRoot) || process.cwd();
    const moduleConfig = { ...DEFAULT_CONFIG, ...(config && config.prQuality) };

    if (!this._isGitRepo(projectRoot)) {
      result.addCheck('pr-quality:not-a-git-repo', true, {
        severity: 'info',
        message: 'Not a git repository — PR-quality check skipped',
      });
      return;
    }

    const base = this._resolveBase(projectRoot, config, moduleConfig);
    if (!base) {
      result.addCheck('pr-quality:no-base-ref', true, {
        severity: 'info',
        message: 'No base ref detected — PR-quality check skipped',
      });
      return;
    }

    // 1. Commit-message quality
    const commits = this._listCommits(projectRoot, base.mergeBase);
    let goodMessages = 0;
    for (const commit of commits) {
      const subject = commit.subject || '';
      const trimmed = subject.trim();
      if (trimmed.length === 0) {
        result.addCheck(`pr-quality:empty-message:${commit.sha}`, false, {
          severity: 'error',
          message: `Commit ${commit.sha.slice(0, 7)} has empty message`,
        });
        continue;
      }
      const tooShort = trimmed.length < moduleConfig.minSubjectLength;
      const weakShape = moduleConfig.weakMessagePatterns.some((re) => re.test(trimmed));
      if (tooShort || weakShape) {
        result.addCheck(`pr-quality:weak-message:${commit.sha}`, false, {
          severity: 'warning',
          message: `Commit ${commit.sha.slice(0, 7)} has weak subject: "${trimmed.slice(0, 60)}"`,
        });
      } else {
        goodMessages += 1;
      }
    }

    // 2. Test-to-source ratio + 3. mixed dependency + code changes.
    // `null` means the diff itself could not be determined (git failed) —
    // that is NOT the same as "nothing changed" and must not be silently
    // read as a clean PR (Doctrine §1: say what was not checked).
    const changedFiles = this._listChangedFiles(projectRoot, base.mergeBase);
    const sourceFiles = [];
    const testFiles = [];
    const depFiles = [];

    if (changedFiles === null) {
      result.addCheck('pr-quality:no-tests:not-checked', true, {
        severity: 'info',
        message: `Could not determine the changed-file diff against ${base.ref} (merge-base ${base.mergeBase.slice(0, 7)}) — source/test ratio and mixed-deps checks not checked`,
      });
    } else {
      const nonDepFiles = [];
      for (const file of changedFiles) {
        if (matchesAny(file, LOCKFILE_PATTERNS)) continue; // ignore lockfiles entirely
        const isTest = this._isTestPath(file);
        const isDep = matchesAny(file, DEP_MANIFEST_PATTERNS);
        if (isTest) testFiles.push(file);
        else if (isDep) depFiles.push(file);
        else nonDepFiles.push(file);
        if (!isTest && !isDep) sourceFiles.push(file);
      }
      const ratio = testFiles.length > 0
        ? sourceFiles.length / testFiles.length
        : sourceFiles.length;
      if (sourceFiles.length >= moduleConfig.minSourceFilesForTestCheck && ratio >= moduleConfig.maxSourceTestRatio) {
        result.addCheck('pr-quality:no-tests', false, {
          severity: 'warning',
          message: `PR changes ${sourceFiles.length} source file(s) but only ${testFiles.length} test file(s). Source-to-test ratio ${ratio.toFixed(1)}:1 — consider adding tests.`,
        });
      }

      if (depFiles.length > 0 && nonDepFiles.length > 0) {
        result.addCheck('pr-quality:mixed-deps-and-code', false, {
          severity: 'warning',
          message: `PR mixes dependency manifest changes (${depFiles.map((f) => path.basename(f)).join(', ')}) with ${nonDepFiles.length} code/test file(s). Dependency upgrades belong in their own PR so they can be reverted independently.`,
        });
      }
    }

    // 4. Summary
    const fileSummary = changedFiles === null
      ? 'changed files not checked'
      : `${sourceFiles.length} source / ${testFiles.length} test / ${depFiles.length} dep file(s) changed`;
    result.addCheck('pr-quality:summary', true, {
      severity: 'info',
      message: `PR-quality: ${commits.length} commit(s), ${goodMessages}/${commits.length} with strong messages, ${fileSummary} against base ${base.ref} (merge-base ${base.mergeBase.slice(0, 7)})`,
    });
  }

  _isGitRepo(root) {
    try {
      return fs.existsSync(path.join(root, '.git'));
    } catch {
      return false;
    }
  }

  /**
   * The ONE base-ref resolution (Doctrine §4) — `resolveDiffBase()` from
   * `src/core/diff-base.js`, shared with `prSize`. Returns a merge-base,
   * never a raw ref, so a `main` that has moved on since the branch forked
   * cannot inflate the diff (see the module doc comment for the incident
   * this fixed). Falls back to `HEAD~1` only when resolveDiffBase finds no
   * base at all (a fresh single-branch repo with no remote and no
   * `main`/`master`) — the same last resort the old auto-detect list used.
   */
  _resolveBase(root, config, moduleConfig) {
    const resolved = resolveDiffBase({
      projectRoot: root,
      explicit: moduleConfig && moduleConfig.against,
      incrementalSince: config && config.incrementalSince,
    });
    if (resolved) return resolved;
    try {
      execSync('git rev-parse --verify --quiet HEAD~1^{commit}', { cwd: root, stdio: 'pipe' });
      const mergeBase = execSync('git merge-base HEAD HEAD~1', {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (mergeBase) return { ref: 'HEAD~1', mergeBase, source: 'head-1-fallback' };
    } catch { /* error-ok — no parent commit (single-commit repo); no base to fall back to */ }
    return null;
  }

  _listCommits(root, mergeBase) {
    try {
      // %H = full SHA, %s = subject; null-separated subject to handle newlines safely.
      const out = execSync(`git log --format=%H%x09%s ${mergeBase}..HEAD`, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 4 * 1024 * 1024,
      });
      return out
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [sha, ...rest] = line.split('\t');
          return { sha, subject: rest.join('\t') };
        });
    } catch {
      return [];
    }
  }

  /**
   * @returns {string[]|null} changed file paths, or `null` when the diff
   *   itself could not be computed (distinct from a real empty diff, which
   *   returns `[]`) — the caller reports that as not-checked rather than
   *   as a clean PR.
   */
  _listChangedFiles(root, mergeBase) {
    try {
      const out = execSync(`git diff --name-only ${mergeBase}..HEAD`, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 4 * 1024 * 1024,
      });
      return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch {
      return null;
    }
  }
}

module.exports = PrQualityModule;
// Exposed for tests
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
module.exports.DEP_MANIFEST_PATTERNS = DEP_MANIFEST_PATTERNS;
module.exports.LOCKFILE_PATTERNS = LOCKFILE_PATTERNS;
