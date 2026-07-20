/**
 * Claude / AI-Output Compliance Module.
 *
 * Audits source for the rot-shaped tells that AI coding assistants leave
 * behind. Pairs with `aiHallucination` (which checks invented packages /
 * methods) and `fakeFixDetector` (symptom patches). This module is the
 * code-hygiene side of the AI-output review:
 *
 *   1. Mock-data-in-prod — "John Doe", "jane@example.com", "Lorem ipsum",
 *      "555-0100" phone numbers, `password123` placeholders embedded in
 *      production source paths. Common when an assistant scaffolds a
 *      component with sample data and the dev forgets to wire real data.
 *
 *   2. Not-implemented stubs — `throw new Error("not implemented")`,
 *      `throw new Error("TODO")`, function bodies that contain only a
 *      `// TODO: implement` comment. Ships when the agent quits mid-task.
 *
 *   3. AI-comment-noise (WHAT-not-WHY) — comments that restate the next
 *      line in English: `// Loop through items`, `// Check if user exists`,
 *      `// Initialize the counter`. Reliable AI tell at density.
 *
 *   4. `: any` / `as any` density — > 5 per 100 lines of TS/TSX. The
 *      `typescriptStrictness` module flags individual hits; this is the
 *      density signal that says "this file gave up on types".
 *
 *   5. `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error` density —
 *      > 3 per file. Same "gave up" signal, harder.
 *
 * Each finding gets attributed back through the existing memory module's
 * fix-pattern flywheel — every Claude-rot fix the platform applies makes
 * the next scan sharper.
 *
 * Suppressions:
 *   - `// claude-ok` / `# claude-ok` on same or preceding line.
 *   - Test / fixture / story paths downgrade error → warning.
 *   - `.md` / `.mdx` / `.rst` / `.txt` skipped (mock data is fine in docs).
 *   - `.stories.*`, `*.test.*`, `*.spec.*`, `mock*` filenames are skipped
 *     for the mock-data rule.
 *
 * Competitors: none. Snyk/Sonar/DeepSource have nothing AI-output-aware.
 * ESLint's `no-warning-comments` is the closest neighbour and only
 * matches TODO/FIXME literally.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage',
  '.gatetest', '.next', 'out', 'target', 'vendor', '.terraform',
  '__pycache__', '.cache', '.parcel-cache', '.turbo', '.vercel',
]);

const SCAN_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.py',
]);
const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);

const TEST_PATH_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e|fixtures?|stories|mocks?|examples?|docs?)\//i;
const TEST_FILE_RE = /\.(?:test|spec|e2e|stories)\.[a-z0-9]+$/i;
const MOCK_FILE_RE = /(?:^|\/)(?:mock|fixture|seed|example|demo)[^/]*$/i;
const MINIFIED_RE = /\.(?:min|bundle|prod)\.[a-z]+$/i;

const SUPPRESS_RE = /\bclaude-ok\b/;

// Mock-data signals — chosen for low false-positive rate. Each pattern
// has appeared verbatim in production codebases from assistant scaffolds.
const MOCK_DATA_PATTERNS = [
  { re: /\bJohn\s+Doe\b/, label: 'John Doe placeholder' },
  { re: /\bJane\s+Doe\b/, label: 'Jane Doe placeholder' },
  { re: /\bjane@example\.(?:com|org)\b/i, label: 'jane@example placeholder email' },
  { re: /\bjohn@example\.(?:com|org)\b/i, label: 'john@example placeholder email' },
  { re: /\btest@test\.com\b/i, label: 'test@test placeholder email' },
  { re: /\bfoo@bar\.com\b/i, label: 'foo@bar placeholder email' },
  { re: /\bLorem\s+ipsum\s+dolor\b/i, label: 'Lorem ipsum filler text' },
  { re: /\b555-0\d{3}\b/, label: 'fake "555-" phone number' },
  { re: /\b123\s+Main\s+St(?:reet)?\b/i, label: '"123 Main St" placeholder address' },
  { re: /["'`]password123["'`]/, label: '"password123" placeholder secret' },
  { re: /["'`]changeme["'`]/i, label: '"changeme" placeholder secret' },
  { re: /\b4242[\s-]?4242[\s-]?4242[\s-]?4242\b/, label: 'Stripe-test card 4242… in non-test path' },
];

// Not-implemented stub signals.
const STUB_PATTERNS = [
  { re: /throw\s+new\s+Error\s*\(\s*["'`]\s*(?:not\s*implemented|TODO|unimplemented|stub)\b/i, label: '"not implemented" stub throw' },
  { re: /raise\s+NotImplementedError\b/, label: 'Python NotImplementedError stub' },
  { re: /\/\/\s*TODO:?\s*implement\b/i, label: '"TODO: implement" placeholder' },
  { re: /\/\/\s*FIXME:?\s*implement\b/i, label: '"FIXME: implement" placeholder' },
  { re: /#\s*TODO:?\s*implement\b/i, label: '"TODO: implement" placeholder' },
];

// WHAT-not-WHY comment noise. Each phrase, on its own line as a comment,
// is a tell. We require the comment to be the WHOLE line (no trailing
// code) and to be in the canonical AI-scaffold form.
const NOISE_PATTERNS = [
  /^\s*\/\/\s*(?:loop\s+through|iterate\s+over)\s+\w/i,
  /^\s*\/\/\s*check\s+if\s+\w/i,
  /^\s*\/\/\s*initialize\s+(?:the\s+)?\w/i,
  /^\s*\/\/\s*create\s+a\s+new\s+\w/i,
  /^\s*\/\/\s*function\s+to\s+\w/i,
  /^\s*\/\/\s*helper\s+function\s+(?:to|for)\b/i,
  /^\s*\/\/\s*(?:import|export|define|declare)\s+the\s+\w/i,
  /^\s*\/\/\s*(?:get|set|return)\s+the\s+\w/i,
  /^\s*\/\/\s*step\s+\d+\s*[:-]/i,
  /^\s*#\s*(?:loop\s+through|iterate\s+over)\s+\w/i,
  /^\s*#\s*check\s+if\s+\w/i,
  /^\s*#\s*initialize\s+(?:the\s+)?\w/i,
];

// TypeScript "gave up" markers.
const TS_ANY_RE = /(?::\s*any\b|\bas\s+any\b)/g;
const TS_IGNORE_RE = /@ts-(?:ignore|nocheck|expect-error)\b/g;

const DENSITY_ANY_THRESHOLD = 5;     // per 100 lines
const DENSITY_TS_IGNORE_THRESHOLD = 3; // per file

class ClaudeComplianceModule extends BaseModule {
  constructor() {
    super(
      'claudeCompliance',
      'AI-output compliance auditor — mock data in prod, stub bodies, comment noise, any/@ts-ignore density'
    );
  }

  async run(result, config) {
    const projectRoot = (config && config.projectRoot) || process.cwd();
    const files = this._collect(projectRoot);

    if (files.length === 0) {
      result.addCheck('claude-compliance:no-files', true, {
        severity: 'info',
        message: 'No source files to scan',
      });
      return;
    }

    result.addCheck('claude-compliance:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} file(s)`,
      fileCount: files.length,
    });

    let issues = 0;

    for (const abs of files) {
      const rel = path.relative(projectRoot, abs).replace(/\\/g, '/');
      if (MINIFIED_RE.test(rel)) continue;
      let text;
      try {
        text = fs.readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      if (text.length > 2 * 1024 * 1024) continue;

      const isTest = TEST_PATH_RE.test(rel) || TEST_FILE_RE.test(rel);
      const isMockFile = MOCK_FILE_RE.test(rel);
      const ext = path.extname(abs).toLowerCase();
      const lines = text.split('\n');

      issues += this._scanFile(rel, lines, result, { isTest, isMockFile, ext });
    }

    result.addCheck('claude-compliance:summary', true, {
      severity: 'info',
      message: `${files.length} file(s) scanned, ${issues} compliance issue(s)`,
      fileCount: files.length,
      issueCount: issues,
    });
  }

  _scanFile(rel, lines, result, ctx) {
    let issues = 0;
    let anyHits = 0;
    let tsIgnoreHits = 0;
    let noiseHits = 0;
    const noiseLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prev = i > 0 ? lines[i - 1] : '';
      if (SUPPRESS_RE.test(line) || SUPPRESS_RE.test(prev)) continue;

      // 1. Mock-data — only in non-test, non-mock source paths.
      if (!ctx.isTest && !ctx.isMockFile) {
        for (const p of MOCK_DATA_PATTERNS) {
          if (p.re.test(line)) {
            result.addCheck(`claude-compliance:mock-data:${rel}:${i + 1}`, false, {
              severity: 'warning',
              message: `Mock data left in source — ${p.label}`,
              file: rel,
              line: i + 1,
              rule: 'mock-data',
            });
            issues++;
            break;
          }
        }
      }

      // 2. Not-implemented stubs.
      for (const p of STUB_PATTERNS) {
        if (p.re.test(line)) {
          result.addCheck(`claude-compliance:stub:${rel}:${i + 1}`, false, {
            severity: ctx.isTest ? 'info' : 'error',
            message: `Not-implemented stub — ${p.label}`,
            file: rel,
            line: i + 1,
            rule: 'stub',
          });
          issues++;
          break;
        }
      }

      // 3. AI WHAT-not-WHY comment noise — track for density.
      for (const re of NOISE_PATTERNS) {
        if (re.test(line)) {
          noiseHits++;
          if (noiseLines.length < 5) noiseLines.push(i + 1);
          break;
        }
      }

      // 4 + 5. TS density counters.
      if (TS_EXTS.has(ctx.ext)) {
        const aMatches = line.match(TS_ANY_RE);
        if (aMatches) anyHits += aMatches.length;
        const iMatches = line.match(TS_IGNORE_RE);
        if (iMatches) tsIgnoreHits += iMatches.length;
      }
    }

    // Comment-noise density — > 3 per 200 lines indicates AI scaffolding.
    const noiseDensity = (noiseHits / Math.max(lines.length, 1)) * 200;
    if (noiseHits >= 3 && noiseDensity >= 3) {
      result.addCheck(`claude-compliance:comment-noise:${rel}`, false, {
        severity: ctx.isTest ? 'info' : 'warning',
        message: `${noiseHits} WHAT-not-WHY comment(s) at lines ${noiseLines.join(', ')}${noiseHits > noiseLines.length ? ', …' : ''}`,
        file: rel,
        rule: 'comment-noise',
        count: noiseHits,
      });
      issues++;
    }

    // `any` density per 100 lines.
    if (TS_EXTS.has(ctx.ext) && lines.length >= 30) {
      const density = (anyHits / Math.max(lines.length, 1)) * 100;
      if (density >= DENSITY_ANY_THRESHOLD) {
        result.addCheck(`claude-compliance:any-density:${rel}`, false, {
          severity: ctx.isTest ? 'info' : 'warning',
          message: `${anyHits} \`any\` use(s) across ${lines.length} lines (${density.toFixed(1)}/100) — file gave up on types`,
          file: rel,
          rule: 'any-density',
          count: anyHits,
          density: Number(density.toFixed(2)),
        });
        issues++;
      }
    }

    // `@ts-ignore` density.
    if (TS_EXTS.has(ctx.ext) && tsIgnoreHits >= DENSITY_TS_IGNORE_THRESHOLD) {
      result.addCheck(`claude-compliance:ts-ignore-density:${rel}`, false, {
        severity: ctx.isTest ? 'info' : 'warning',
        message: `${tsIgnoreHits} @ts-ignore / @ts-nocheck / @ts-expect-error in one file`,
        file: rel,
        rule: 'ts-ignore-density',
        count: tsIgnoreHits,
      });
      issues++;
    }

    return issues;
  }

  _collect(root) {
    const out = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (EXCLUDE_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.') && e.name !== '.') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          if (SCAN_EXTS.has(ext)) out.push(full);
        }
      }
    };
    walk(root);
    return out;
  }
}

module.exports = ClaudeComplianceModule;
