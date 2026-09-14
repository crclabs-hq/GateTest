/**
 * GateTest Memory Store
 *
 * Persistent, repo-local memory that makes every GateTest scan smarter than
 * the last. Stores the detected stack, an append-only history of every
 * issue ever recorded, applied fixes, and user-dismissed false positives.
 *
 * The competitive moat: scans compound. Competitors reset to zero every run;
 * GateTest accumulates context that no fixed ruleset can replicate.
 *
 * Storage layout (under <project>/.gatetest/memory/):
 *   fingerprint.json   — detected languages, frameworks, conventions
 *   issues.jsonl       — append-only log: one JSON per line per issue ever seen
 *   scans.json         — summary of every scan (timestamp, counts, status)
 *   false-positives.json — { [checkKey]: { reason, dismissedAt } }
 *   fix-patterns.json  — { version, patterns: { [patternKey]: { count, lastAt, examples } } }
 *
 * Serverless-safe: all state lives on disk inside the scanned repo. The web
 * service can still use this — each serverless invocation clones the repo
 * and gets the memory that travels with it.
 *
 * TODO(gluecron): memory sync hook — when Gluecron repos ship, expose an
 * HTTP endpoint that lets the git host push memory between mirrors.
 */

const fs = require('fs');
const path = require('path');
const { isExcludedDir } = require('./walk-excludes');

const MEMORY_DIR = '.gatetest/memory';

class MemoryStore {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.dir = path.join(projectRoot, MEMORY_DIR);
    this.files = {
      fingerprint: path.join(this.dir, 'fingerprint.json'),
      issues: path.join(this.dir, 'issues.jsonl'),
      scans: path.join(this.dir, 'scans.json'),
      falsePositives: path.join(this.dir, 'false-positives.json'),
      fixPatterns: path.join(this.dir, 'fix-patterns.json'),
    };
  }

  _ensureDir() {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  _readJson(file, fallback) {
    try {
      if (!fs.existsSync(file)) return fallback;
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return fallback;
    }
  }

  _writeJson(file, data) {
    this._ensureDir();
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  _appendJsonl(file, obj) {
    this._ensureDir();
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  }

  _readJsonl(file) {
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  }

  /**
   * Load the full memory snapshot.
   */
  load() {
    return {
      fingerprint: this._readJson(this.files.fingerprint, null),
      issues: this._readJsonl(this.files.issues),
      scans: this._readJson(this.files.scans, { totalScans: 0, runs: [] }),
      falsePositives: this._readJson(this.files.falsePositives, {}),
      fixPatterns: this._readJson(this.files.fixPatterns, { version: 1, patterns: {} }),
    };
  }

  /**
   * Derive a stable pattern key from a full check name. Universal-checker
   * names look like "python:eval:src/foo.py:42" — the first two segments
   * identify the pattern independently of file/line.
   */
  _patternKeyFromCheckName(checkName) {
    if (!checkName) return null;
    const parts = String(checkName).split(':');
    if (parts.length < 2) return parts[0] || null;
    return `${parts[0]}:${parts[1]}`;
  }

  /**
   * Record a fix that was successfully applied by auto-fix. Builds up a
   * repo-local database of "what has this project fixed before," which
   * downstream modules (memory summary, aiReview) can surface back to the
   * user and to Claude.
   *
   * Retains at most 5 recent examples per pattern to cap file growth.
   */
  recordFix({ checkName, description, filesChanged = [] }) {
    const patternKey = this._patternKeyFromCheckName(checkName);
    if (!patternKey) return null;
    const db = this._readJson(this.files.fixPatterns, { version: 1, patterns: {} });
    if (!db.patterns[patternKey]) {
      db.patterns[patternKey] = { count: 0, lastAt: null, examples: [] };
    }
    const entry = db.patterns[patternKey];
    entry.count = (entry.count || 0) + 1;
    entry.lastAt = new Date().toISOString();
    entry.examples = [
      { at: entry.lastAt, checkName, description, filesChanged },
      ...(entry.examples || []),
    ].slice(0, 5);
    this._writeJson(this.files.fixPatterns, db);
    return { patternKey, count: entry.count };
  }

  /**
   * Return the full fix-pattern database.
   */
  getFixPatterns() {
    return this._readJson(this.files.fixPatterns, { version: 1, patterns: {} });
  }

  /**
   * Look up a historical fix pattern for a given check name. Returns null
   * if the pattern has never been fixed in this repo.
   */
  getFixFor(checkName) {
    const patternKey = this._patternKeyFromCheckName(checkName);
    if (!patternKey) return null;
    const db = this.getFixPatterns();
    const entry = db.patterns[patternKey];
    if (!entry) return null;
    return { patternKey, ...entry };
  }

  /**
   * Record that a scan happened. Keeps at most the last 100 summaries to
   * avoid unbounded growth.
   */
  recordScan(summary) {
    const scans = this._readJson(this.files.scans, { totalScans: 0, runs: [] });
    scans.totalScans = (scans.totalScans || 0) + 1;
    scans.runs = [
      ...(scans.runs || []),
      {
        at: summary.timestamp || new Date().toISOString(),
        gateStatus: summary.gateStatus,
        issueCount: summary.issueCount || 0,
        errorCount: summary.errorCount || 0,
      },
    ].slice(-100);
    this._writeJson(this.files.scans, scans);
  }

  /**
   * Append issues from a scan summary to the append-only log.
   * De-duplicates against the most recent 500 issues on the same check key.
   */
  ingestIssues(issues) {
    if (!Array.isArray(issues) || issues.length === 0) return 0;
    const seen = new Set(
      this._readJsonl(this.files.issues).slice(-500).map((i) => i._key),
    );
    let added = 0;
    for (const issue of issues) {
      const key = `${issue.module || ''}:${issue.name || ''}:${issue.file || ''}:${issue.line || 0}`;
      if (seen.has(key)) continue;
      this._appendJsonl(this.files.issues, {
        _key: key,
        at: new Date().toISOString(),
        module: issue.module,
        name: issue.name,
        severity: issue.severity,
        file: issue.file,
        line: issue.line,
        message: issue.message,
      });
      seen.add(key);
      added += 1;
    }
    return added;
  }

  /**
   * Return issues that have appeared in at least `threshold` historical scans.
   * Uses the check key as the identity.
   */
  getRecurringIssues(threshold = 3) {
    const counts = new Map();
    for (const issue of this._readJsonl(this.files.issues)) {
      counts.set(issue._key, (counts.get(issue._key) || 0) + 1);
    }
    const recurring = [];
    for (const [key, count] of counts.entries()) {
      if (count >= threshold) recurring.push({ key, count });
    }
    return recurring.sort((a, b) => b.count - a.count);
  }

  /**
   * Check whether a check has been dismissed as a false positive.
   */
  isFalsePositive(checkKey) {
    const fps = this._readJson(this.files.falsePositives, {});
    return Boolean(fps[checkKey]);
  }

  dismiss(checkKey, reason) {
    const fps = this._readJson(this.files.falsePositives, {});
    fps[checkKey] = { reason, dismissedAt: new Date().toISOString() };
    this._writeJson(this.files.falsePositives, fps);
  }

  /**
   * Detect the repo fingerprint: languages present, frameworks hinted by
   * package.json / similar, and high-level conventions.
   */
  detectFingerprint() {
    const fingerprint = {
      at: new Date().toISOString(),
      languages: this._detectLanguages(),
      frameworks: this._detectFrameworks(),
      conventions: this._detectConventions(),
    };
    this._writeJson(this.files.fingerprint, fingerprint);
    return fingerprint;
  }

  _detectLanguages() {
    const counts = {};
    const walk = (dir, depth = 0) => {
      if (depth > 6) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (isExcludedDir(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (ext) counts[ext] = (counts[ext] || 0) + 1;
        }
      }
    };
    walk(this.projectRoot);
    const extToLang = {
      '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
      '.ts': 'typescript', '.tsx': 'typescript',
      '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
      '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.cs': 'csharp',
      '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
      '.ex': 'elixir', '.exs': 'elixir', '.dart': 'dart', '.lua': 'lua',
      '.sh': 'shell', '.bash': 'shell',
    };
    const langs = {};
    for (const [ext, count] of Object.entries(counts)) {
      const lang = extToLang[ext];
      if (lang) langs[lang] = (langs[lang] || 0) + count;
    }
    return langs;
  }

  _detectFrameworks() {
    const hints = [];
    const pkgPath = path.join(this.projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        const known = {
          next: 'nextjs', react: 'react', vue: 'vue', svelte: 'svelte',
          '@angular/core': 'angular', express: 'express', fastify: 'fastify',
          koa: 'koa', nestjs: 'nestjs', astro: 'astro', remix: 'remix',
          jest: 'jest', vitest: 'vitest', mocha: 'mocha', playwright: 'playwright',
          cypress: 'cypress', tailwindcss: 'tailwind', typescript: 'typescript',
        };
        for (const dep of Object.keys(deps)) {
          if (known[dep]) hints.push(known[dep]);
        }
      } catch { /* error-ok — unreadable package.json — stack hints stay empty; the syntax module reports the file */ }
    }
    if (fs.existsSync(path.join(this.projectRoot, 'pyproject.toml'))) hints.push('python-project');
    if (fs.existsSync(path.join(this.projectRoot, 'go.mod'))) hints.push('go-module');
    if (fs.existsSync(path.join(this.projectRoot, 'Cargo.toml'))) hints.push('cargo');
    if (fs.existsSync(path.join(this.projectRoot, 'Gemfile'))) hints.push('bundler');
    return Array.from(new Set(hints));
  }

  _detectConventions() {
    const conv = {};
    if (fs.existsSync(path.join(this.projectRoot, '.prettierrc'))) conv.prettier = true;
    if (fs.existsSync(path.join(this.projectRoot, 'eslint.config.mjs'))
      || fs.existsSync(path.join(this.projectRoot, '.eslintrc'))
      || fs.existsSync(path.join(this.projectRoot, '.eslintrc.json'))) conv.eslint = true;
    if (fs.existsSync(path.join(this.projectRoot, 'tsconfig.json'))) conv.typescript = true;
    if (fs.existsSync(path.join(this.projectRoot, '.github/workflows'))) conv.githubActions = true;
    return conv;
  }

  /**
   * Ingest the most recent GateTest JSON report, if present, and append its
   * issues to the history log. Returns the number of new issues added.
   */
  ingestLatestReport() {
    const reportPath = path.join(this.projectRoot, '.gatetest/reports/gatetest-report-latest.json');
    if (!fs.existsSync(reportPath)) return { scanIngested: false, newIssues: 0 };
    let report;
    try {
      report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    } catch {
      return { scanIngested: false, newIssues: 0 };
    }
    const issues = [];
    for (const module of report.results || []) {
      for (const check of module.checks || []) {
        if (check.passed) continue;
        issues.push({
          module: module.module,
          name: check.name,
          severity: check.severity,
          file: check.file,
          line: check.line,
          message: check.message,
        });
      }
    }
    const added = this.ingestIssues(issues);
    this.recordScan({
      timestamp: report.gatetest?.timestamp,
      gateStatus: report.gatetest?.gateStatus,
      issueCount: (report.summary?.checks?.failed) || 0,
      errorCount: (report.summary?.checks?.errors) || 0,
    });
    return { scanIngested: true, newIssues: added };
  }
}

module.exports = { MemoryStore, MEMORY_DIR };
