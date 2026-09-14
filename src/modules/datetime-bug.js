/**
 * Datetime / Timezone Bug Detector Module.
 *
 * Every long-running codebase eventually ships a datetime bug to prod.
 * The bug fires intermittently, "works on my machine", passes every
 * unit test because the dev machine and the CI runner share a
 * timezone, and surfaces only when real customers in different
 * timezones hit the API at the wrong boundary. The fix is always
 * obvious in hindsight; the damage is already done.
 *
 * We target five high-precision bug classes — each is a known
 * runtime-silent failure mode, none of them have good built-in
 * linters, and all of them have been the subject of real-world
 * postmortems at major tech companies:
 *
 *   1. Python `datetime.datetime.now()` without a `tz=` argument.
 *      Returns a naive datetime. Comparisons against aware datetimes
 *      raise `TypeError` only at runtime; comparisons against other
 *      naives silently use the server's local timezone. Production
 *      databases stamp UTC; dev laptops stamp local. The bug hides
 *      until the clocks jump.
 *
 *   2. Python `datetime.datetime.utcnow()`. Deprecated in Python
 *      3.12+. Returns a naive datetime representing UTC — which
 *      promptly gets treated as local by any library that checks
 *      `tzinfo is None`. PEP 673 says "use datetime.now(timezone.utc)".
 *
 *   3. JavaScript `new Date(year, monthLiteral, day)` where the month
 *      literal is in 1..12. JS months are 0-indexed (January is 0).
 *      This call shape is nearly always wrong — either it's the bug
 *      ("Feb 14" becomes "Mar 14") or it's correct by accident and
 *      the reader can't tell. Either way it deserves a flag.
 *
 *   4. `Date.UTC(year, monthLiteral, day)` with month literal 1..12.
 *      Same 0-based trap as above — same fix.
 *
 *   5. `moment()` / `moment(x)` used as a timezone-free constructor.
 *      Moment.js has been in legacy mode since 2020 and its own docs
 *      recommend migration to Luxon / date-fns / Day.js / Temporal.
 *      The constructor without an explicit `.tz(...)` silently uses
 *      local time, reproducing bug class #1.
 *
 * Suppressions:
 *   - `// datetime-ok` / `# datetime-ok` on same or preceding line.
 *   - Test / spec / fixture paths downgrade warning → info.
 *   - Block-comment / line-comment / Python docstring stripping.
 *
 * Rules:
 *
 *   warning: Python naive `datetime.now()` — no tz argument.
 *            (rule: `datetime-bug:naive-now:<rel>:<line>`)
 *
 *   warning: Python deprecated `datetime.utcnow()`.
 *            (rule: `datetime-bug:utcnow-deprecated:<rel>:<line>`)
 *
 *            Both are ADVICE, not a gate. Whether a naive datetime is a
 *            bug depends on what it is later compared with or stored as,
 *            which a line scan cannot see; the JS month rules below were
 *            always calibrated as warnings for the same reason. Until
 *            2026-09-14 these two were errors, and django/django was
 *            gate-BLOCKED on seven of them at confidence 1.0 — in the
 *            library that ships `django/utils/timezone.py`. Three more
 *            shapes drop one step further, to info, with the reason in
 *            the message:
 *              - the same line formats the value (`.strftime(`) — a
 *                wall-clock label for a filename, log line or banner,
 *                never a datetime that leaves the line
 *                (django `runserver.py:182`, `migrations/utils.py:24`);
 *              - the file imports an aware-time toolkit
 *                (`django.utils.timezone`, `zoneinfo`, `pytz`,
 *                `dateutil.tz`, `pendulum`, or `timezone`/`tzinfo` from
 *                `datetime`) — a naive call beside it is a choice
 *                (django `db/backends/base/schema.py:491` picks
 *                `timezone.now()` for DateTimeField on the line above);
 *              - the project ships its own `timezone.py` / `tz.py` —
 *                the advice is not news to the library that wrote it.
 *
 *   warning: JS `new Date(year, monthLiteral, day)` with month 1..12.
 *            (rule: `datetime-bug:one-based-month:<rel>:<line>`)
 *
 *   warning: JS `Date.UTC(year, monthLiteral, day)` with month 1..12.
 *            (rule: `datetime-bug:utc-one-based-month:<rel>:<line>`)
 *
 *   warning: `moment()` constructor with no explicit timezone call.
 *            (rule: `datetime-bug:moment-no-tz:<rel>:<line>`)
 *
 * Competitors:
 *   - ESLint has nothing on naive datetimes.
 *   - `pylint` / `ruff` flag `datetime.utcnow` in Py 3.12+ but don't
 *     cross-reference with `datetime.now()` missing tz.
 *   - `moment-deprecation-handler` is a runtime shim, not a linter.
 *   - SonarQube has one Java-only rule on `java.util.Date`.
 *   - Nothing unifies Python naive-datetime + JS 0-vs-1 month + moment
 *     legacy detection at the gate.
 *
 * TODO(gluecron): host-neutral — pure static scan.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');

const JS_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
]);
const PY_EXTS = new Set(['.py']);


const SUPPRESS_RE = /\bdatetime-ok\b/;

// ---- Pattern regexes ----

// Python: `datetime.now()` / `datetime.datetime.now()` WITHOUT tz= arg
// inside the parens. Conservative — only flag when the whole call fits
// on one line and has no `tz` / `tzinfo` / `timezone` substring.
const PY_NAIVE_NOW_RE = /\b(?:datetime\.)?datetime\.now\s*\(([^)]*)\)/;
const PY_UTCNOW_RE = /\b(?:datetime\.)?datetime\.utcnow\s*\(\s*\)/;

// The naive value is formatted on the same line — a wall-clock label
// (filename stamp, log line, server banner). It never leaves the line as a
// datetime, so there is nothing for a timezone to disagree with.
const PY_FORMATTED_ON_LINE_RE = /\.(?:strftime|isoformat|ctime)\s*\(/;

// The file has an aware-time toolkit in scope. A naive call written next to
// `timezone.now()` / `ZoneInfo(...)` is a decision, not an oversight.
const PY_AWARE_TOOLKIT_IMPORT_RE =
  /^\s*(?:from\s+(?:django\.utils|zoneinfo|pytz|dateutil(?:\.tz)?|pendulum|datetime)\s+import\s+[^\n]*\b(?:timezone|tz|tzinfo|ZoneInfo|utc|UTC)\b|import\s+(?:pytz|zoneinfo|pendulum|dateutil\.tz)\b|from\s+django\.utils\.timezone\s+import\b)/m;

// The project implements timezone utilities itself (django ships
// `django/utils/timezone.py`). Matched by basename among the scanned files.
const PY_TZ_MODULE_RE = /(?:^|[\\/])(?:timezone|tz|tzinfo|tzutil|timezones)\.py$/i;

// JS: `new Date(year, monthLiteral, ...)` with 4-digit year and month 1..12.
const JS_ONE_BASED_MONTH_RE = /\bnew\s+Date\s*\(\s*(\d{4})\s*,\s*(\d{1,2})\s*(?:,|\))/;

// JS: `Date.UTC(year, monthLiteral, ...)` with same shape.
const JS_UTC_ONE_BASED_RE = /\bDate\.UTC\s*\(\s*(\d{4})\s*,\s*(\d{1,2})\s*(?:,|\))/;

// Moment constructor — flag only when no `.tz(` follows on the same
// line and no `moment.tz(` form (which is explicit).
const MOMENT_CALL_RE = /\bmoment\s*\(/;
const MOMENT_TZ_RE = /\bmoment\.tz\s*\(|\.tz\s*\(/;

class DatetimeBugModule extends BaseModule {
  constructor() {
    super('datetimeBug', 'Datetime / timezone bug detector — naive datetimes, 0-vs-1 month, moment-legacy');
  }

  async run(result, config) {
    const projectRoot = (config && config.projectRoot) || process.cwd();
    const files = this._collect(projectRoot);

    if (files.length === 0) {
      result.addCheck('datetime-bug:no-files', true, {
        severity: 'info',
        message: 'No source files to scan',
      });
      return;
    }

    result.addCheck('datetime-bug:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} file(s)`,
      fileCount: files.length,
    });

    // Does this project ship its own timezone module? Decided once from the
    // file list; every Python finding in the project then reads as info.
    const projectTzModule = files.find((abs) => PY_TZ_MODULE_RE.test(abs));
    const py = { tzModule: projectTzModule ? repoRelative(projectRoot, projectTzModule) : null };

    let issues = 0;
    for (const abs of files) {
      const rel = repoRelative(projectRoot, abs);
      let text;
      try {
        text = fs.readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      if (text.length > 5 * 1024 * 1024) continue;

      const ext = path.extname(abs).toLowerCase();
      if (JS_EXTS.has(ext)) {
        issues += this._scanJs(rel, text, result);
      } else if (PY_EXTS.has(ext)) {
        issues += this._scanPy(rel, text, result, py);
      }
    }

    result.addCheck('datetime-bug:summary', true, {
      severity: 'info',
      message: `${files.length} file(s) scanned, ${issues} issue(s)`,
      fileCount: files.length,
      issueCount: issues,
    });
  }

  // KI #104: the shared walk replaces a private readdir copy so `--diff` /
  // `--pr` scans only touch changed files. The old walk also skipped every
  // dot-name (`.storybook/`, `.eslintrc.js`) — kept as a filter so the file
  // set is unchanged; `.terraform` is the one exclude not in the defaults.
  _collect(root) {
    return this._collectFiles(root, [...JS_EXTS, ...PY_EXTS], ['.terraform'])
      .filter((abs) => !repoRelative(root, abs).split('/').some((s) => s.startsWith('.')));
  }

  _scanJs(rel, text, result) {
    const isTest = this._isTestPath(rel);
    const errSev = isTest ? 'info' : 'warning'; // JS rules are already warning-level; test downgrades to info
    const lines = text.split(/\r?\n/);
    let issues = 0;
    let inBlock = false;

    for (let i = 0; i < lines.length; i += 1) {
      let line = lines[i];

      // Block-comment state
      if (inBlock) {
        const endIdx = line.indexOf('*/');
        if (endIdx === -1) continue;
        line = line.slice(endIdx + 2);
        inBlock = false;
      }
      const startBlock = line.indexOf('/*');
      if (startBlock !== -1) {
        const endBlock = line.indexOf('*/', startBlock + 2);
        if (endBlock === -1) {
          inBlock = true;
          line = line.slice(0, startBlock);
        } else {
          line = line.slice(0, startBlock) + line.slice(endBlock + 2);
        }
      }
      // Strip line comments
      const lc = line.indexOf('//');
      if (lc !== -1) line = line.slice(0, lc);

      if (this._suppressed(lines, i)) continue;

      // Rule 3: new Date(y, m, d) with m in 1..12
      const m1 = JS_ONE_BASED_MONTH_RE.exec(line);
      if (m1) {
        const year = parseInt(m1[1], 10);
        const month = parseInt(m1[2], 10);
        if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12) {
          result.addCheck(`datetime-bug:one-based-month:${rel}:${i + 1}`, false, {
            severity: errSev,
            message: `new Date(${year}, ${month}, ...) — JS months are 0-indexed. Month ${month} means ${this._monthName(month)}, did you mean ${this._monthName(month - 1)}?`,
            file: rel,
            line: i + 1,
            year,
            monthLiteral: month,
          });
          issues += 1;
        }
      }

      // Rule 4: Date.UTC(y, m, d) with m in 1..12
      const m2 = JS_UTC_ONE_BASED_RE.exec(line);
      if (m2) {
        const year = parseInt(m2[1], 10);
        const month = parseInt(m2[2], 10);
        if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12) {
          result.addCheck(`datetime-bug:utc-one-based-month:${rel}:${i + 1}`, false, {
            severity: errSev,
            message: `Date.UTC(${year}, ${month}, ...) — Date.UTC months are 0-indexed. Month ${month} means ${this._monthName(month)}, did you mean ${this._monthName(month - 1)}?`,
            file: rel,
            line: i + 1,
            year,
            monthLiteral: month,
          });
          issues += 1;
        }
      }

      // Rule 5: moment() without .tz
      if (MOMENT_CALL_RE.test(line) && !MOMENT_TZ_RE.test(line)) {
        // NO import/require skip here, deliberately. A whole-line skip on any
        // line containing the words import or require used to sit here, to
        // avoid firing on `import moment from 'moment'` — but MOMENT_CALL_RE is
        // /\bmoment\s*\(/ and an import specifier never contains `moment(`,
        // so it guarded nothing. What it DID do was silence real findings:
        // measured on a fixture, `const h = require('./h'); const t = moment();`
        // was skipped purely because the line mentions require.
        // Verified before removal: import/require statements still produce no
        // finding, and that line now does. See tests/datetime-bug-import-skip.test.js.
        // Skip comments / type annotations
        if (/^\s*\*/.test(line)) continue;
        result.addCheck(`datetime-bug:moment-no-tz:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: `moment() without .tz(...) — silently uses local time. Migrate to Luxon / date-fns / Temporal.`,
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }
    }
    return issues;
  }

  _scanPy(rel, text, result, ctx = {}) {
    const isTest = this._isTestPath(rel);
    // Advice, not a gate: warning in shipped code, info in a test path.
    const baseSev = isTest ? 'info' : 'warning';
    // File- and project-level reasons the advice is already known here.
    // Each drops the finding to info and is named in the message.
    const awareToolkit = PY_AWARE_TOOLKIT_IMPORT_RE.test(text);
    const fileReason = awareToolkit
      ? 'this file imports an aware-time toolkit, so the naive call beside it reads as a choice'
      : ctx.tzModule
        ? `this project ships its own timezone module (${ctx.tzModule})`
        : null;
    // Severity and reason for one finding on `codeLine`.
    const grade = (codeLine) => {
      if (PY_FORMATTED_ON_LINE_RE.test(codeLine)) {
        return { severity: 'info', reason: 'the value is formatted on the same line — a wall-clock label, not a datetime that leaves the line' };
      }
      if (fileReason) return { severity: 'info', reason: fileReason };
      return { severity: baseSev, reason: null };
    };
    const withReason = (message, reason) => (reason ? `${message} Not blocking: ${reason}.` : message);
    const lines = text.split(/\r?\n/);
    let issues = 0;
    let inDocstring = false;
    let docQuote = null;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      // Docstring tracking — triple-quoted strings only on their own line
      if (inDocstring) {
        if (line.includes(docQuote)) {
          inDocstring = false;
          docQuote = null;
        }
        continue;
      }
      const m3 = line.match(/^\s*(["']{3})/);
      if (m3) {
        // Single-line triple-quoted?
        const rest = line.slice(line.indexOf(m3[1]) + 3);
        if (!rest.includes(m3[1])) {
          inDocstring = true;
          docQuote = m3[1];
          continue;
        }
      }

      // Line comments
      let codeLine = line;
      const hashIdx = this._findUnquotedHash(codeLine);
      if (hashIdx !== -1) codeLine = codeLine.slice(0, hashIdx);

      if (this._suppressed(lines, i)) continue;

      // Rule 1: datetime.now() without tz=
      const m1 = PY_NAIVE_NOW_RE.exec(codeLine);
      if (m1) {
        const args = m1[1].trim();
        // `datetime.now(<anything>)` is AWARE: the sole parameter IS the tz.
        // The old check looked for the keyword spellings (`tz=`, `timezone`,
        // `ZoneInfo`) and missed the positional form — `datetime.now(tz)`,
        // `datetime.now(tzinfo)`, `datetime.now(UTC if aware else None)` —
        // which is what django/core/mail/message.py:358 and humanize.py:197
        // write. Only an empty call, or an explicit `None`, is naive.
        if (args === '' || args === 'None') {
          const { severity, reason } = grade(codeLine);
          result.addCheck(`datetime-bug:naive-now:${rel}:${i + 1}`, false, {
            severity,
            message: withReason('datetime.now() without tz= argument — returns naive datetime. Use datetime.now(timezone.utc) or datetime.now(ZoneInfo("...")).', reason),
            file: rel,
            line: i + 1,
          });
          issues += 1;
        }
      }

      // Rule 2: datetime.utcnow() — always deprecated
      if (PY_UTCNOW_RE.test(codeLine)) {
        const { severity, reason } = grade(codeLine);
        result.addCheck(`datetime-bug:utcnow-deprecated:${rel}:${i + 1}`, false, {
          severity,
          message: withReason('datetime.utcnow() is deprecated (Python 3.12+) and returns a naive datetime. Use datetime.now(timezone.utc).', reason),
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }
    }
    return issues;
  }

  _suppressed(lines, i) {
    return (lines[i] && SUPPRESS_RE.test(lines[i])) ||
      (i > 0 && lines[i - 1] && SUPPRESS_RE.test(lines[i - 1]));
  }

  _findUnquotedHash(line) {
    let inStr = null;
    for (let j = 0; j < line.length; j += 1) {
      const ch = line[j];
      if (inStr) {
        if (ch === '\\') { j += 1; continue; }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = ch;
        continue;
      }
      if (ch === '#') return j;
    }
    return -1;
  }

  _monthName(n) {
    const names = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    if (n < 0 || n > 11) return `month-${n}`;
    return names[n];
  }
}

module.exports = DatetimeBugModule;
