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
const { repoRelative } = require('../core/repo-path');
const BaseModule = require('./base-module');
const { literalKindAt } = require('../core/source-strip');

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
  { re: /\bLorem\s+ipsum\s+dolor\b/i, label: 'Lorem ipsum filler text', prose: true },
  { re: /\b555-0\d{3}\b/, label: 'fake "555-" phone number' },
  { re: /\b123\s+Main\s+St(?:reet)?\b/i, label: '"123 Main St" placeholder address' },
  { re: /["'`]password123["'`]/, label: '"password123" placeholder secret' },
  { re: /["'`]changeme["'`]/i, label: '"changeme" placeholder secret' },
  { re: /\b4242[\s-]?4242[\s-]?4242[\s-]?4242\b/, label: 'Stripe-test card 4242… in non-test path' },
];

// Not-implemented stub signals. Each carries `commentOnly`: true when the
// pattern's own definition of a stub IS a bare comment (the `// TODO:
// implement` family) — those must sit in a real comment to mean anything.
// `throw`/`raise` patterns are the opposite: they describe EXECUTABLE code,
// so a match sitting inside a comment or string never actually runs and is
// not a stub (see kindAt gating in _scanFile).
const STUB_PATTERNS = [
  { re: /throw\s+new\s+Error\s*\(\s*["'`]\s*(?:not\s*implemented|TODO|unimplemented|stub)\b/i, label: '"not implemented" stub throw' },
  // Only a BARE raise. `raise NotImplementedError("Streamed bodies and files
  // are mutually exclusive.")` is a deliberate API constraint that explains
  // itself — a stub, by definition, does not. Measured 2026-09-01 on
  // psf/requests @5460f46, src/requests/models.py:623, where exactly that
  // line was reported as unfinished work.
  //
  // `NotImplementedError()` with empty parens is still a stub candidate: no
  // message, no explanation, same crash for the caller.
  { re: /raise\s+NotImplementedError\s*(?:\(\s*\))?\s*(?:#.*)?$/, label: 'Python NotImplementedError stub' },
  { re: /\/\/\s*TODO:?\s*implement\b/i, label: '"TODO: implement" placeholder', commentOnly: true },
  { re: /\/\/\s*FIXME:?\s*implement\b/i, label: '"FIXME: implement" placeholder', commentOnly: true },
  { re: /#\s*TODO:?\s*implement\b/i, label: '"TODO: implement" placeholder', commentOnly: true },
];

/**
 * True when the match at [start, end) on `line` sits inside a backtick
 * inline-code span on the SAME raw line — a JSDoc/markdown comment quoting
 * a pattern as an example (`` `throw new Error("not implemented")` ``, ``
 * `// TODO: implement` `` comment) rather than asserting it. This module's
 * own doc comment describing these exact patterns is the case that proved
 * it necessary (self-scan 2026-09-16, src/modules/claude-compliance.js:14-16)
 * — the mock-data rule has the identical "a detector's own description is
 * not data" problem, solved the same way for that rule in mockDataContext.
 */
function isBacktickQuoted(line, start, end) {
  const before = line.lastIndexOf('`', start);
  if (before === -1) return false;
  const after = line.indexOf('`', end);
  return after !== -1;
}

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

// A quoted placeholder that is COMPARED, not assigned: `=== 'changeme'`,
// `.has('changeme')`, `case 'changeme':` — a guard against the value, which
// is the opposite of shipping it.
const COMPARAND_BEFORE_RE = /(?:===?|!==?|\.(?:includes|has|startsWith|endsWith|indexOf|test)\s*\(|\bcase)\s*$/;
// The opener of a multi-line list a quoted placeholder sits in: a lookup Set
// of the values a detector recognises (src/core/env-placeholder.js).
const LOOKUP_OPENER_RE = /\bnew\s+Set\s*\(/;
// A string literal longer than this is prose ABOUT a placeholder ("weak
// session secrets like 'changeme'"), not the placeholder itself.
const PROSE_LITERAL_LENGTH = 60;

/**
 * Where a mock-data match sits, judged on the masked twin of the line
 * (src/core/source-strip.js): 'code' at the opening quote of a whole
 * string literal, 'string' inside one, 'comment', or 'regex'.
 *
 * Self-scan 2026-09-13: every one of the 18 mock-data findings on this
 * repo was a DETECTOR — this module's own MOCK_DATA_PATTERNS (regex
 * literals), the secrets / security / cookie-security modules' comments
 * naming "changeme", env-placeholder's Set of the placeholders it
 * recognises, and website copy describing what cookieSecurity flags. A
 * comment or a regex is never data; a string is data only when it IS the
 * placeholder rather than a sentence mentioning one.
 */
function mockDataContext(rawLines, maskedLines, i, col, quoted, prose) {
  const kind = literalKindAt(rawLines, maskedLines, i, col);
  if (kind === 'comment' || kind === 'regex') return 'detector';
  const masked = maskedLines[i] || '';
  if (quoted) {
    // The pattern starts at a quote. As a whole literal that quote is a
    // DELIMITER and survives masking; nested inside a larger string it is
    // interior and was blanked.
    if (kind !== 'code') return 'prose';
    if (COMPARAND_BEFORE_RE.test(masked.slice(0, col))) return 'comparand';
    if (insideLookupList(maskedLines, i)) return 'comparand';
    return 'data';
  }
  if (kind === 'code') return 'data'; // JSX text: <p>Lorem ipsum dolor</p>
  if (prose) return 'data'; // Lorem ipsum IS long prose; length says nothing about it
  // Length of the enclosing literal: walk out to the delimiters the mask kept.
  let start = col;
  while (start > 0 && !/["'`]/.test(masked[start - 1])) start -= 1;
  let end = col;
  while (end < masked.length && !/["'`]/.test(masked[end])) end += 1;
  return end - start > PROSE_LITERAL_LENGTH ? 'prose' : 'data';
}

/** Is line `i` a continuation of a `new Set([` list opened above? */
function insideLookupList(maskedLines, i) {
  for (let k = i; k >= 0 && k >= i - 12; k -= 1) {
    const l = (maskedLines[k] || '').trim();
    if (LOOKUP_OPENER_RE.test(l)) return true;
    if (k < i && !/[[(,{=]$/.test(l)) return false; // the statement started here without the opener
  }
  return false;
}

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
      const rel = repoRelative(projectRoot, abs);
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
      const lines = text.split(/\r?\n/);
      const masked = this._maskedLines(text, rel);

      issues += this._scanFile(rel, lines, result, { isTest, isMockFile, ext, masked });
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
    const maskedLines = ctx.masked || this._maskedLines(lines.join('\n'), rel);
    const kindAt = (i, col) => literalKindAt(lines, maskedLines, i, col);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prev = i > 0 ? lines[i - 1] : '';
      if (SUPPRESS_RE.test(line) || SUPPRESS_RE.test(prev)) continue;
      const maskedLine = maskedLines[i] || '';

      // 1. Mock-data — only in non-test, non-mock source paths, and only
      // where the match is DATA (see mockDataContext).
      if (!ctx.isTest && !ctx.isMockFile) {
        for (const p of MOCK_DATA_PATTERNS) {
          const m = p.re.exec(line);
          if (m) {
            const quoted = /^["'`]/.test(m[0]);
            const where = mockDataContext(lines, maskedLines, i, m.index, quoted, p.prose === true);
            if (where !== 'data') break;
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

      // 2. Not-implemented stubs. `raise NotImplementedError` inside an
      // abstract base / interface method (the surrounding class subclasses
      // ABC, the method has a docstring, or the module defines an
      // `abstractmethod`) is the CORRECT Python idiom for "subclasses must
      // override" — Flask's own base classes tripped 11 blocking errors on
      // it (2026-08-18 audit). Only a bare stub in a concrete function is a
      // finding (it crashes whoever calls it at runtime).
      for (const p of STUB_PATTERNS) {
        const sm = p.re.exec(line);
        if (sm) {
          // A stub is code or a TODO comment; the same text inside a
          // string or a regex literal (this module's own STUB_PATTERNS) is
          // neither.
          const k = kindAt(i, sm.index);
          if (k === 'string' || k === 'regex') break;
          if (p.commentOnly) {
            // `// TODO: implement` etc. only mean something as a REAL
            // comment left in code — and not when that comment is itself
            // quoting the pattern as a doc example (backtick-fenced, as in
            // this file's own JSDoc).
            if (k !== 'comment') break;
            if (isBacktickQuoted(line, sm.index, sm.index + sm[0].length)) break;
          } else {
            // throw/raise patterns describe EXECUTABLE code — the same text
            // sitting in a comment (including a doc comment quoting it in
            // backticks, as this file's own JSDoc does) never runs.
            if (k !== 'code') break;
          }
          if (/NotImplementedError/.test(p.label) && ClaudeComplianceModule._looksAbstract(lines, i, lines.join('\n'))) break;
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

      // 3. AI WHAT-not-WHY comment noise — track for density. A comment
      // is a comment only outside a string: the same line inside a
      // template literal is content, not a tell.
      const commentAt = line.search(/\S/);
      if (commentAt >= 0 && kindAt(i, commentAt) === 'comment') {
        for (const re of NOISE_PATTERNS) {
          if (re.test(line)) {
            noiseHits++;
            if (noiseLines.length < 5) noiseLines.push(i + 1);
            break;
          }
        }
      }

      // 4 + 5. TS density counters. `: any` is a type only in CODE, and a
      // `@ts-ignore` is a directive only in a COMMENT — website/app/for/
      // typescript/page.tsx shows 13 of them inside a template literal of
      // example code and was reported as a file that "gave up on types"
      // (self-scan 2026-09-13).
      if (TS_EXTS.has(ctx.ext)) {
        const aMatches = maskedLine.match(TS_ANY_RE);
        if (aMatches) anyHits += aMatches.length;
        for (const im of line.matchAll(TS_IGNORE_RE)) {
          if (kindAt(i, im.index) === 'comment') tsIgnoreHits += 1;
        }
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
    // KI #104: shared walk replaces the private one. The old walk also
    // skipped every dot-entry below the root (`.github/`, `.storybook/`,
    // `.eslintrc.js`); kept as a filter so the file set is unchanged.
    return this._collectFiles(root, [...SCAN_EXTS], ['.terraform']).filter((full) => {
      const rel = repoRelative(root, full);
      return !rel.split(/[\\/]/).some((seg) => seg.startsWith('.'));
    });
  }
}

/**
 * True when a `raise NotImplementedError` at `lineIdx` sits in an abstract /
 * interface context: the file imports ABC/abstractmethod, the enclosing
 * class derives from ABC/Protocol/Interface, the method is decorated
 * `@abstractmethod`, or the method body opens with a docstring (the
 * documented "override me" contract).
 */
ClaudeComplianceModule._looksAbstract = function (lines, lineIdx, content) {
  if (/from\s+abc\s+import|import\s+abc\b|\babstractmethod\b|typing\.Protocol|\(Protocol\)|\bInterface\b/.test(content)) return true;
  const indent = (l) => (l.match(/^\s*/) || [''])[0].length;
  const myIndent = indent(lines[lineIdx] || '');
  // Find the enclosing `def` (lower indent, walking up).
  // Count triple-quote delimiters between a candidate line and the raise. An
  // ODD number means the candidate sits INSIDE a docstring, so it is prose —
  // not the enclosing signature.
  //
  // Flask's `add_url_rule` docstring contains a `.. code-block:: python`
  // example whose body is `def index():`. Walking up from the
  // `raise NotImplementedError`, that example matched first, and the method
  // was judged concrete: a blocking "not-implemented stub" on the correct
  // Python idiom for "subclasses must override".
  //
  // Measured 2026-09-01, the first time the engine was ever run on a Python
  // repo (pallets/flask @d318b68, src/flask/sansio/scaffold.py:441). The
  // existing guard already handled the bare case 220 lines earlier in the
  // same file — it was documentation examples it could not see.
  //
  // The lookback is also widened: a 60-line window cannot reach past a long
  // API docstring to the real `def`, which is exactly where these live.
  const insideDocstring = (fromIdx) => {
    let q = 0;
    for (let k = fromIdx; k < lineIdx; k++) {
      const m = (lines[k] || '').match(/"""|'''/g);
      if (m) q += m.length;
    }
    return q % 2 === 1;
  };

  let defIdx = -1;
  for (let k = lineIdx - 1; k >= 0 && k >= lineIdx - 250; k--) {
    const l = lines[k];
    if (!l.trim()) continue;
    if (indent(l) < myIndent && /^\s*(async\s+)?def\s+/.test(l)) {
      if (insideDocstring(k)) continue; // a `def` in a doc example, not ours
      defIdx = k;
      break;
    }
    if (indent(l) < myIndent && /^\s*class\s+/.test(l) && !insideDocstring(k)) break;
  }
  if (defIdx === -1) return false;
  const deco = lines[defIdx - 1] || '';
  if (/@\w*abstract\w*|@overload/.test(deco)) return true;
  // End of the (possibly multi-line) signature: first line from the def
  // that ends with ':' (ignoring trailing comments).
  let sigEnd = defIdx;
  for (let k = defIdx; k < lineIdx; k++) {
    if (/:\s*(#.*)?$/.test(lines[k])) { sigEnd = k; break; }
  }
  // Body between the signature and the raise: only docstring / comments /
  // blank lines means the method EXISTS to say "override me" — the Python
  // abstract-method idiom, not an unfinished stub.
  const TQ = /"""|'''/;
  const body = lines.slice(sigEnd + 1, lineIdx).map((l) => l.trim()).filter(Boolean);
  let inDoc = false;
  let hasDocstring = false;
  for (const l of body) {
    if (inDoc) { if (TQ.test(l)) inDoc = false; continue; }
    if (/^r?("""|''')/.test(l)) {
      hasDocstring = true;
      const closes = (l.match(new RegExp(TQ.source, 'g')) || []).length >= 2;
      if (!closes) inDoc = true;
      continue;
    }
    if (l.startsWith('#') || l === 'pass' || l === '...') continue;
    return false; // real logic before the raise → a genuine stub in a concrete function
  }
  // A METHOD whose whole body is the raise (with or without a docstring)
  // is the "subclasses override this" idiom. A bare module-level FUNCTION
  // that only raises is an unfinished stub — flag it.
  const isMethod = indent(lines[defIdx]) > 0 || /^\s*(async\s+)?def\s+\w+\s*\(\s*(self|cls)\b/.test(lines[defIdx]);
  return hasDocstring || isMethod;
};

module.exports = ClaudeComplianceModule;
