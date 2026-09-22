/**
 * Money / Currency Float-Safety Detector Module.
 *
 * Storing currency in a floating-point type is the textbook bug
 * that every fintech eventually ships. `0.1 + 0.2 !== 0.3` is the
 * punchline — a $100.00 invoice becomes $99.99999999... after three
 * additions; a $0.01 fee over a million transactions accrues
 * hundreds of dollars of drift; a $19.99 line item rounds to $20.00
 * on display and to $19.989 in the database. Regulators call this
 * fraud. Tax authorities call this fraud. Your customers call this
 * fraud.
 *
 * The fix is always: use a fixed-precision decimal type. In JS:
 * Decimal.js, big.js, bignumber.js, dinero.js, currency.js. In
 * Python: the `decimal.Decimal` type from the stdlib. In Go:
 * `math/big` or `shopspring/decimal`. In Java: `BigDecimal`. The
 * anti-pattern we catch: a money-named variable (`price`, `total`,
 * `amount`, `tax`, `subtotal`, `balance`, currency codes like `usd`,
 * `eur`, etc.) assigned from `parseFloat(...)` / `Number(...)` in
 * JS or `float(...)` in Python, or receiving `.toFixed(0)` /
 * `.toFixed(1)` (sub-cent precision) when no decimal library is
 * visible in the file.
 *
 * Rules:
 *
 *   error:   JS: money-named variable assigned from `parseFloat(...)`
 *            or `Number(...)`.
 *            (rule: `money-float:js-parse-float:<rel>:<line>`)
 *
 *   error:   Python: money-named variable assigned from `float(...)`.
 *            (rule: `money-float:py-float-cast:<rel>:<line>`)
 *
 *   warning: `.toFixed(0)` or `.toFixed(1)` on a money-named variable.
 *            Sub-cent precision — rounding bugs are almost certain.
 *            (rule: `money-float:insufficient-precision:<rel>:<line>`)
 *
 *   error:   plain arithmetic (`*`, `/`, `+=`, `-=`, `*=`, `/=`) applied
 *            directly to a money-named identifier or property access with
 *            no decimal library in scope. JS has no separate int type —
 *            `price * (1 + taxRate)` and `total += item.price * item.qty`
 *            ARE float arithmetic, with no explicit cast required to
 *            trigger the exact `0.1 + 0.2 !== 0.3` bug this module exists
 *            to catch. EXCEPTION: the four generic accumulator names
 *            `total`/`balance`/`credit`/`margin` double as plain counters
 *            in real repos (`all.total += 1`, `total += items.length`) —
 *            those four only fire when the same statement also carries a
 *            SECOND, distinct money-named identifier (`total += item.price
 *            * item.qty` fires via `price`), and never fire on a bare
 *            integer increment or a `.length` read. Specific names
 *            (price, cost, fee, salary, ...) are unambiguous and keep
 *            firing alone.
 *            (rule: `money-float:arithmetic:<rel>:<line>`)
 *
 *   info:    Decimal library detected (safe-harbour marker).
 *            (rule: `money-float:decimal-library-ok`)
 *
 * Suppressions:
 *   - `// money-float-ok` / `# money-float-ok` on same or preceding line.
 *   - Test / spec / fixture paths downgrade error → warning.
 *   - If file imports a known decimal library (decimal.js, big.js,
 *     bignumber.js, dinero.js, currency.js, @decimal, or Python
 *     `decimal` / `from decimal import Decimal`), the entire file is
 *     treated as safe-harbour — no float-cast rule fires.
 *   - `.gatetestignore` for deliberate, legitimate corroborating samples
 *     (e.g. marketing/demo code that intentionally renders the anti-pattern).
 *
 * Competitors:
 *   - SonarQube has one Java-only rule on `float`/`double` for
 *     money — nothing for JS / Python / Go.
 *   - ESLint has nothing. Pylint has nothing. ruff has nothing.
 *   - Semgrep has a handful of community rules with high FP.
 *   - Nothing unifies JS + Python + library-aware safe-harbour at the gate.
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


const SUPPRESS_RE = /\bmoney-float-ok\b/;

// Money-named identifiers. We anchor on the IDENTIFIER, not the
// value. Conservative list to keep FP rate low — only terms that
// are unambiguously about money.
const MONEY_NAME_RE =
  /\b(price|amount|total|cost|fee|tax|subtotal|balance|payment|charge|refund|credit|debit|salary|wage|rent|bill|invoice|revenue|profit|margin|discount|coupon|tip|gratuity|usd|eur|gbp|jpy|cad|aud|nzd|chf|dollar|dollars|euro|euros|pound|pounds|yen|yuan|rupee|peso|cents?)s?\b/i;

// #666: `money-float:arithmetic` fired on a duration parser
// (`apps/api/src/automation/freshness.ts:351`, seconds only, no money
// anywhere in the file) because several MONEY_NAME_RE words (`cost`,
// `charge`, `credit`, `discount`, currency codes, ...) double as ordinary
// English outside a money domain. This narrower list is the money-CONTEXT
// signal: bare mul/div arithmetic (the shape with no cast and no compound
// accumulator, `price * 1.15`) now also requires one of these words —
// unambiguous even alone — or a money-typed import to appear somewhere in
// the file before it fires. `stripe` covers importing a payment SDK
// directly; `MONEY_TYPED_IMPORT_RE` covers a shared `Money` type instead.
// Deliberately narrower than MONEY_NAME_RE: this is corroboration, not the
// trigger, so the overloaded words above must not satisfy it on their own.
const MONEY_CONTEXT_RE = /\b(price|amount|cents?|currency|total|invoice|payment|balance|fee|tax|stripe)\b/i;
const MONEY_TYPED_IMPORT_RE = /\bimport\b[^;\n]{0,120}\bMoney\b|:\s*Money(?:\[\])?\b/;

function hasMoneyContext(text) {
  return MONEY_CONTEXT_RE.test(text) || MONEY_TYPED_IMPORT_RE.test(text);
}

// A handful of MONEY_NAME_RE entries double as plain accumulator/counter
// names in non-money contexts (`all.total += 1`, `total += items.length`,
// a running `balance` of unrelated items, a loop `credit`/`margin` counter).
// For these — and ONLY these — the arithmetic rule (below) requires a SECOND,
// distinct money-named identifier in the same statement before firing, and
// never fires on a bare integer increment or a `.length` read. Specific
// names (price, cost, fee, salary, ...) are unambiguous and keep firing alone.
const GENERIC_MONEY_NAMES = new Set(['total', 'balance', 'credit', 'margin']);

// RHS shapes that are never a currency computation even when the accumulator
// is named `total`/`balance`/etc: a bare integer literal (`total += 1`) or a
// `.length` property read (`total += items.length`).
const TRIVIAL_INCREMENT_RHS_RE = /^\s*\d+\s*;?\s*$/;
const DOT_LENGTH_RHS_RE = /^\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.length\s*;?\s*$/;

function isGenericMoneyName(identifier) {
  const parts = String(identifier || '').split('.');
  return GENERIC_MONEY_NAMES.has(parts[parts.length - 1].toLowerCase());
}

function isTrivialIncrementRhs(rhs) {
  const trimmed = String(rhs || '').trim();
  return TRIVIAL_INCREMENT_RHS_RE.test(trimmed) || DOT_LENGTH_RHS_RE.test(trimmed);
}

// True when `line` carries a money-named identifier OTHER than `exclude`
// (case-insensitive, whole-word) — corroboration required before a generic
// accumulator name fires on its own. `exclude` may be a dotted access
// (`stats.total`); the identifier tokenizer below yields dotted paths as
// SEPARATE tokens (`stats`, `total`), so comparison is against `exclude`'s
// own last dotted segment — otherwise the accumulator's tail token (`total`)
// never matches the full dotted exclude string and self-corroborates.
function hasCorroboratingMoneyIdentifier(line, exclude) {
  const excludeParts = String(exclude || '').toLowerCase().split('.');
  const excludeLast = excludeParts[excludeParts.length - 1];
  const idRe = /[A-Za-z_$][\w$]*/g;
  let m;
  while ((m = idRe.exec(line)) !== null) {
    if (m[0].toLowerCase() === excludeLast) continue;
    if (MONEY_NAME_RE.test(m[0])) return true;
  }
  return false;
}

// A `/` immediately followed by 0-3 lowercase regex-flag letters then `.` is
// almost certainly a JS regex literal's closing delimiter chained straight
// into a method call (`/pattern/i.test(x)`), not division — e.g. a money-named
// word inside a regex alternation like `/credit|balance/i.test(msg)` reads as
// "credit / i" to a naive identifier-then-operator scan. Real division never
// has zero whitespace on both sides AND a bare method call as the divisor.
const REGEX_LITERAL_TAIL_RE = /^[a-z]{0,3}\./;

// JS: `const price = parseFloat(...)` / `let total = Number(...)` /
// `var amount = +input`.
const JS_ASSIGN_FLOAT_RE =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:\w<>\s,|&]*=\s*(parseFloat|Number)\s*\(/;
// Class / object property form: `this.price = parseFloat(...)` /
// `obj.total = Number(...)`.
const JS_PROP_FLOAT_RE =
  /\b(?:this|[A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*=\s*(parseFloat|Number)\s*\(/;

// Python: `price = float(x)` / `self.total = float(x)`.
const PY_ASSIGN_FLOAT_RE =
  /\b(?:self\.)?([A-Za-z_][\w]*)\s*(?::\s*[\w[\]., ]+)?\s*=\s*float\s*\(/;

// `.toFixed(N)`. We capture N so we can check precision.
const TOFIXED_RE = /([A-Za-z_$][\w$]*)\.toFixed\s*\(\s*(\d+)\s*\)/;

// Compound assignment directly on a money-named identifier — e.g.
// `total += item.price * item.qty`. The accumulator itself never goes
// through parseFloat/Number, but every `+=` on a JS number IS float
// arithmetic, so this is the same bug class as the explicit-cast rule.
const JS_COMPOUND_ASSIGN_RE = /\b([A-Za-z_$][\w$]*)\s*(\+=|-=|\*=|\/=)/;

// Multiplication / division directly on a money-named identifier or
// money-named property access (`price * (...)`, `item.price * item.qty`).
// Negative lookahead on `=` excludes `*=`/`/=` (handled by the compound-
// assignment rule above) and `==`/`===`.
const JS_MONEY_MULDIV_RE = /\b((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\s*([*/])(?!=)\s*\S/;

// Minor-units display: `cents / 100` (or 1000, 10000) whose result is
// consumed by a formatter on the same line — Math.round/floor/ceil,
// .toFixed, Intl.NumberFormat / toLocaleString — or interpolated straight
// into a template literal. The identifier must NAME minor units (cents,
// pence, minor, subunit, satoshi…) so `price / 100` still fires.
const MINOR_UNITS_NAME_RE = /(?:^|[._$])(?:cents?|pence|pennies|minor(?:Units?)?|sub[-_]?units?|sat(?:oshi)?s?|_?in_?cents)$/i;
const DISPLAY_FORMATTER_RE = /\bMath\.(?:round|floor|ceil|trunc)\s*\(|\.toFixed\s*\(|\bIntl\.NumberFormat\b|\.toLocaleString\s*\(|\.format\s*\(/;

// issue #633 (2026-09-22): `const label = cents / 100;` — no formatter call
// and no template literal on the SAME line, so it fell through the two
// checks above and fired as "money arithmetic" even though nothing is
// stored: the result goes straight into a variable the FILE ITSELF names
// as display text. The identifier, not the value (same principle as
// MONEY_NAME_RE) — a target named `label`/`display`/`text`/… is read by a
// person, not persisted or computed on further, so this is the same
// "render minor units for a human" idiom the formatter/template checks
// already exempt. `total`/`amount`/etc. as a target name do NOT match this
// list — only names that say "this is text for display", so `const total =
// cents / 100` (a stored, further-computable total) still fires.
const DISPLAY_TARGET_WORDS = new Set([
  'label', 'display', 'formatted', 'text', 'caption', 'pretty', 'readable',
  'string', 'str', 'html', 'markup', 'title', 'subtitle', 'placeholder',
]);
// `const label =` / `let display: string =` / bare `label = ` reassignment,
// optionally opening one or more parens before the arithmetic starts
// (`const label = (cents / 100).toFixed(2)`).
const ASSIGN_TARGET_RE = /(?:\b(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\(*$/;
function nameWords(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[_\-\s]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}
function isDisplayTargetName(name) {
  return nameWords(name).some((w) => DISPLAY_TARGET_WORDS.has(w));
}

function isMinorUnitsDisplay(line, mArith, opIdx) {
  if (mArith[2] !== '/') return false;
  if (!MINOR_UNITS_NAME_RE.test(mArith[1])) return false;
  const rhs = line.slice(opIdx + 1).trimStart();
  if (!/^(?:100|1000|10000|1e2|1e3|1e4)\b/.test(rhs)) return false;
  const before = line.slice(0, mArith.index);
  const inTemplate = /\$\{[^}]*$/.test(before);
  if (DISPLAY_FORMATTER_RE.test(before) || inTemplate) return true;
  const target = ASSIGN_TARGET_RE.exec(before);
  return !!(target && isDisplayTargetName(target[1]));
}

// Library-detection patterns. If any of these appear anywhere in
// the file, we treat the file as safe-harbour for the float-cast
// rules (but .toFixed is still checked, since devs sometimes use
// both incorrectly).
const LIBRARY_PATTERNS = [
  /\brequire\s*\(\s*['"](decimal\.js|big\.js|bignumber\.js|dinero\.js|currency\.js|@decimal|money-math|cashify)['"]/,
  /\bfrom\s+['"](decimal\.js|big\.js|bignumber\.js|dinero\.js|currency\.js|@decimal|money-math|cashify)['"]/,
  /\bimport\s+[\s\S]{0,100}\bfrom\s+['"](decimal\.js|big\.js|bignumber\.js|dinero\.js|currency\.js|@decimal|money-math|cashify)['"]/,
  /\bfrom\s+decimal\s+import\s+Decimal\b/,           // Python stdlib
  /\bimport\s+decimal\b/,                             // Python stdlib
  /\bDinero\s*\(/,                                    // dinero.js constructor
  /\bnew\s+Decimal\s*\(/,                             // decimal.js constructor
  /\bnew\s+BigNumber\s*\(/,                           // bignumber.js constructor
  /\bnew\s+Big\s*\(/,                                 // big.js constructor
];

class MoneyFloatModule extends BaseModule {
  constructor() {
    super('moneyFloat', 'Money / currency float-safety detector — catches IEEE-754 precision loss on currency-named variables');
  }

  async run(result, config) {
    const projectRoot = (config && config.projectRoot) || process.cwd();
    const files = this._collect(projectRoot);

    if (files.length === 0) {
      result.addCheck('money-float:no-files', true, {
        severity: 'info',
        message: 'No source files to scan',
      });
      return;
    }

    result.addCheck('money-float:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} file(s)`,
      fileCount: files.length,
    });

    let issues = 0;
    let filesWithLibrary = 0;

    for (const abs of files) {
      const rel = repoRelative(projectRoot, abs);
      let text;
      try {
        text = fs.readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      if (text.length > 5 * 1024 * 1024) continue;

      const hasLibrary = LIBRARY_PATTERNS.some((re) => re.test(text));
      if (hasLibrary) filesWithLibrary += 1;

      const ext = path.extname(abs).toLowerCase();
      if (JS_EXTS.has(ext)) {
        issues += this._scanJs(rel, text, result, hasLibrary);
      } else if (PY_EXTS.has(ext)) {
        issues += this._scanPy(rel, text, result, hasLibrary);
      }
    }

    if (filesWithLibrary > 0) {
      result.addCheck('money-float:decimal-library-ok', true, {
        severity: 'info',
        message: `${filesWithLibrary} file(s) import a decimal-safe library — safe-harbour applied`,
        fileCount: filesWithLibrary,
      });
    }

    result.addCheck('money-float:summary', true, {
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

  _scanJs(rel, text, result, hasLibrary) {
    const isTest = this._isTestPath(rel);
    const sev = { err: isTest ? 'warning' : 'error', warn: isTest ? 'info' : 'warning' };
    const lines = text.split(/\r?\n/);
    // Every rule matches on the MASKED line (BaseModule._maskedLines): string,
    // template, regex and comment bodies are blanked, offsets preserved. A
    // line of documentation like
    //   moneyFloat: "const total = parseFloat(priceString)",
    // was once reported at ERROR severity — blocking a build over a code
    // sample that never executes (Bible Forbidden #25; caught by
    // tests/heavy/inert-fixture-sweep.test.js). The per-line quote counter
    // that replaced it could not see a template literal or a block comment
    // that started on an earlier line; the whole-file mask can (2026-09-05).
    const masked = this._maskedLines(text);
    // #666: computed once per file — a money-named import, type or
    // identifier anywhere in the file (or, transitively, in any function in
    // it) corroborates the bare mul/div arithmetic rule below. See
    // MONEY_CONTEXT_RE for why this list is narrower than MONEY_NAME_RE.
    const fileHasMoneyContext = hasMoneyContext(text);
    let issues = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const code = masked[i] || '';
      if (!code.trim() || this._suppressed(lines, i)) continue;
      const at = { rel, line: i + 1, sev, fileHasMoneyContext };
      if (!hasLibrary) {
        issues += this._castRule(code, at, result);
        issues += this._arithmeticRule(code, at, result);
      }
      issues += this._toFixedRule(code, at, result);
    }
    return issues;
  }

  // Rule 1: money-named var assigned from parseFloat / Number
  _castRule(code, at, result) {
    let issues = 0;
    const m1 = JS_ASSIGN_FLOAT_RE.exec(code);
    if (m1 && MONEY_NAME_RE.test(m1[1])) {
      result.addCheck(`money-float:js-parse-float:${at.rel}:${at.line}`, false, {
        severity: at.sev.err,
        message: `Money-named variable "${m1[1]}" assigned from ${m1[2]}(...) — IEEE-754 precision loss. Use Decimal.js / big.js / dinero.js.`,
        file: at.rel,
        line: at.line,
        variable: m1[1],
      });
      issues += 1;
    }
    const m2 = JS_PROP_FLOAT_RE.exec(code);
    if (m2 && MONEY_NAME_RE.test(m2[1])) {
      result.addCheck(`money-float:js-parse-float-prop:${at.rel}:${at.line}`, false, {
        severity: at.sev.err,
        message: `Money-named property ".${m2[1]}" assigned from ${m2[2]}(...) — IEEE-754 precision loss.`,
        file: at.rel,
        line: at.line,
        property: m2[1],
      });
      issues += 1;
    }
    return issues;
  }

  // Rule 2: plain arithmetic directly on a money-named identifier —
  // no parseFloat/Number cast needed to trigger this bug class. JS has
  // one numeric type (float64), so `price * (1 + taxRate)` and
  // `total += item.price * item.qty` accumulate the exact same
  // rounding error as an explicit cast. Compound-assign checked first
  // so a line like `total += item.price * item.qty` reports once
  // (on the accumulator) instead of twice (accumulator + RHS product).
  //
  // Generic accumulator names (total/balance/credit/margin) double as
  // plain counters in real repos (`all.total += 1`, `total += items.length`)
  // — those four names only fire when the SAME statement carries a second,
  // distinct money-named identifier (`total += item.price * item.qty`
  // fires via `price`) and never on a bare integer increment or a
  // `.length` read. Specific names (price, cost, fee, salary, ...) keep
  // firing alone, unchanged.
  _arithmeticRule(code, at, result) {
    const mCompound = JS_COMPOUND_ASSIGN_RE.exec(code);
    if (mCompound && MONEY_NAME_RE.test(mCompound[1])) {
      const rhs = code.slice(mCompound.index + mCompound[0].length);
      const generic = isGenericMoneyName(mCompound[1]);
      const fires = generic
        ? hasCorroboratingMoneyIdentifier(code, mCompound[1]) && !isTrivialIncrementRhs(rhs)
        : true;
      if (!fires) return 0;
      result.addCheck(`money-float:arithmetic:${at.rel}:${at.line}`, false, {
        severity: at.sev.err,
        message: `Money-named variable "${mCompound[1]}" accumulated via \`${mCompound[2]}\` — plain float arithmetic on a JS number, the same precision-loss risk as parseFloat/Number. Use Decimal.js / big.js / dinero.js.`,
        file: at.rel,
        line: at.line,
        variable: mCompound[1],
      });
      return 1;
    }
    const mArith = JS_MONEY_MULDIV_RE.exec(code);
    if (!mArith || !MONEY_NAME_RE.test(mArith[1])) return 0;
    // #666: bare mul/div (no cast, no compound accumulator) is the shape a
    // unit-conversion helper uses too (`seconds * 60`, `ms / 1000`) — unlike
    // the compound-assign accumulator above, a single arithmetic expression
    // is not on its own strong enough evidence of money without some other
    // money-named identifier, import or type in the file.
    if (!at.fileHasMoneyContext) return 0;
    const opIdx = code.indexOf(mArith[2], mArith.index + mArith[1].length);
    const isRegexLiteralTail = mArith[2] === '/' && REGEX_LITERAL_TAIL_RE.test(code.slice(opIdx + 1));
    const generic = isGenericMoneyName(mArith[1]);
    // Integer minor units rendered for display — `cents / 100` fed
    // straight into Math.round / toFixed / Intl.NumberFormat or a
    // template literal — is the correct way to SHOW money stored as
    // cents; nothing is computed with the float and nothing stores
    // it. Surfaced by the in-string guard learning that `${…}` is
    // code (website/app/checkout/page.tsx:17, 2026-09-05). A value
    // that is assigned, returned bare, or passed to anything else
    // still fires.
    const isDisplayOfMinorUnits = isMinorUnitsDisplay(code, mArith, opIdx);
    const fires = !isRegexLiteralTail && !isDisplayOfMinorUnits && (generic ? hasCorroboratingMoneyIdentifier(code, mArith[1]) : true);
    if (!fires) return 0;
    result.addCheck(`money-float:arithmetic:${at.rel}:${at.line}`, false, {
      severity: at.sev.err,
      message: `Money-named value "${mArith[1]}" used directly in \`${mArith[2]}\` arithmetic — plain float math on a JS number, the same precision-loss risk as parseFloat/Number. Use Decimal.js / big.js / dinero.js.`,
      file: at.rel,
      line: at.line,
      variable: mArith[1],
    });
    return 1;
  }

  // Rule 3: .toFixed(N) with N < 2 on a money-named receiver
  // Skip display-only contexts: inside template literals, JSX, or string concat.
  _toFixedRule(code, at, result) {
    const m3 = TOFIXED_RE.exec(code);
    if (!m3) return 0;
    const receiver = m3[1];
    const precision = parseInt(m3[2], 10);
    if (precision >= 2 || !MONEY_NAME_RE.test(receiver)) return 0;
    // Skip when used inside a template literal (display formatting)
    const beforeMatch = code.slice(0, m3.index);
    const isDisplayContext = /`[^`]*$/.test(beforeMatch)   // inside template literal
      || /['"][^'"]*$/.test(beforeMatch)                   // inside string concat
      || />\s*\{[^}]*$/.test(beforeMatch)                  // inside JSX children
      || /return\s+$/.test(beforeMatch.trim());            // bare return (display fn)
    if (isDisplayContext) return 0;
    result.addCheck(`money-float:insufficient-precision:${at.rel}:${at.line}`, false, {
      severity: at.sev.warn,
      message: `${receiver}.toFixed(${precision}) — sub-cent precision on money variable. Use .toFixed(2) or a decimal library.`,
      file: at.rel,
      line: at.line,
      variable: receiver,
      precision,
    });
    return 1;
  }

  _scanPy(rel, text, result, hasLibrary) {
    if (hasLibrary) return 0;  // file uses `decimal` module — safe
    const isTest = this._isTestPath(rel);
    const errSev = isTest ? 'warning' : 'error';
    const lines = text.split(/\r?\n/);
    let issues = 0;
    let inDocstring = false;
    let docQuote = null;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      // Docstring tracking
      if (inDocstring) {
        if (line.includes(docQuote)) {
          inDocstring = false;
          docQuote = null;
        }
        continue;
      }
      const m3 = line.match(/^\s*(["']{3})/);
      if (m3) {
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

      const m = PY_ASSIGN_FLOAT_RE.exec(codeLine);
      if (m && MONEY_NAME_RE.test(m[1])) {
        result.addCheck(`money-float:py-float-cast:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: `Money-named variable "${m[1]}" assigned from float(...) — IEEE-754 precision loss. Use decimal.Decimal.`,
          file: rel,
          line: i + 1,
          variable: m[1],
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
}

module.exports = MoneyFloatModule;
