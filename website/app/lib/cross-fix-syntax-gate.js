/**
 * Cross-fix syntax-validation gate.
 *
 * Phase 1.2 of THE FIX-FIRST BUILD PLAN. Sits between
 * `attemptFixWithRetries` (per-file fix) and PR creation. Catches the
 * failure mode where Claude returns plausible-looking content that
 * passes shape + pattern checks but doesn't actually parse — broken
 * brackets, JSX inside a `.json`, truncated mid-statement. The current
 * fix flow has no syntax gate; without this, syntactically invalid
 * fixes can ship to a customer's PR and break their build.
 *
 * Strategy: file-extension dispatch.
 *   - .json     → JSON.parse
 *   - .js .mjs  → vm.compileFunction (zero-dep, native Node syntax check)
 *   - .cjs      → vm.compileFunction
 *   - everything else → accept (TS/TSX/JSX validation requires the
 *     `typescript` package, which is a Boss Rule item to add at the
 *     repo root; flagged for the next session)
 *
 * Pure JS, dependency-injected for tests. The route imports this and
 * calls `validateFixesSyntax({ fixes })` after collecting all per-file
 * fixes, before opening the PR.
 *
 * Outcome:
 *   { accepted: Fix[], rejected: Array<{ file, reason, original, issues }> }
 *
 * Rejected fixes are NOT auto-retried by this gate (the upstream
 * iterative loop is the retry mechanism). They go straight into the
 * orchestrator's `errors` array so the customer sees the full picture.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vm = require('node:vm');

/**
 * Try to syntax-check a single string as JavaScript / CommonJS / ESM.
 * Returns { ok, reason }.
 *
 * vm.compileFunction wraps the source as a function body, which is the
 * fastest zero-dep way to validate syntax without executing anything.
 * It accepts `await` at the top level (function-body context allows it
 * for async wrappers), so legitimate top-level-await modules pass — but
 * truly broken syntax (unmatched braces, stray tokens) throws SyntaxError.
 */
function checkJsSyntax(source) {
  if (typeof source !== 'string' || source.length === 0) {
    return { ok: false, reason: 'empty source' };
  }
  try {
    // Note: vm.compileFunction supports parsing modern JS (ES2022+).
    // Top-level `import`/`export` statements aren't legal in a function
    // body, so for ESM source we strip them before compiling — this
    // doesn't change the bytes that ship to the PR, only what we
    // validate. If the rest of the file parses, we trust the imports.
    const stripped = source
      .replace(/^\s*import\s+[^;]+;?\s*$/gm, '')
      .replace(/^\s*export\s+(?:default\s+)?(?:async\s+)?/gm, '');
    vm.compileFunction(stripped, [], { filename: 'fix-validation.js' });
    return { ok: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, reason: `syntax error: ${message}` };
  }
}

/**
 * TS-family syntax check via the compiler the website already ships
 * (`typescript@^5` in website/package.json — approved stack, not a new
 * dependency). `transpileModule` with reportDiagnostics surfaces SYNTAX
 * errors without type-checking or executing anything, which is exactly
 * a syntax gate's job. Lazy-required with a pass-through fallback so a
 * stripped runtime (npm package without website devDeps) degrades to
 * the old accept-unchecked behavior instead of crashing the fix path.
 * Closes the ".ts/.tsx intentionally unhandled" gap (2026-08-18 audit #7).
 */
let _ts = null;
let _tsTried = false;
let _tsError = null;
function loadTypescript() {
  if (_tsTried) return _ts;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    _ts = require('typescript');
    _tsTried = true;
  } catch (err) {
    // Only "there is no compiler" is the settled, degraded state. Anything
    // else — a transient EMFILE under a loaded test run, a half-written
    // install — used to be swallowed AND cached, so one bad moment turned
    // every later TS fix into an unverified pass with nothing to say why
    // (Linux CI 2026-09-13: three checkTsSyntax tests failed once with
    // `true !== false` and no cause). Now it is retried on the next call and
    // its message travels in the reason.
    _ts = null;
    _tsError = err;
    _tsTried = Boolean(err && err.code === 'MODULE_NOT_FOUND' && /'typescript'/.test(String(err.message)));
  }
  return _ts;
}

function checkTsSyntax(source, fileName) {
  if (typeof source !== 'string' || source.length === 0) {
    return { ok: false, reason: 'empty source' };
  }
  const ts = loadTypescript();
  if (!ts) {
    // typescript unavailable — we cannot validate, so we must not claim we
    // did. Still a pass (failing closed here would break every TS fix on a
    // box where the compiler is simply absent), but flagged `unverified` so
    // the summary and the PR body say so. It is a devDependency of the
    // website, and a production install that omits dev deps would land
    // exactly here — on the PAID fix path, silently reporting "all clean"
    // over fixes nothing had parsed.
    const why = _tsError && _tsError.message ? ` (${String(_tsError.message).split('\n')[0]})` : '';
    return { ok: true, unverified: true, reason: `typescript unavailable — fix not syntax-checked${why}` };
  }
  try {
    // createSourceFile + parseDiagnostics, not transpileModule: the
    // transpiler is deliberately error-tolerant and emits through many
    // parse errors (an unclosed JSX element transpiles "fine"), while
    // parseDiagnostics is the parser's own error list.
    const name = fileName || 'fix-validation.ts';
    const kind = /\.(tsx|jsx)$/i.test(name) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, /* setParentNodes */ false, kind);
    const errors = (sf.parseDiagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length === 0) return { ok: true };
    const first = errors[0];
    const text = ts.flattenDiagnosticMessageText
      ? ts.flattenDiagnosticMessageText(first.messageText, ' ')
      : String(first.messageText);
    return { ok: false, reason: `syntax error: ${text}` };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, reason: `syntax error: ${message}` };
  }
}

/**
 * Try to syntax-check a single string as JSON.
 */
function checkJsonSyntax(source) {
  if (typeof source !== 'string' || source.length === 0) {
    return { ok: false, reason: 'empty source' };
  }
  try {
    JSON.parse(source);
    return { ok: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, reason: `invalid JSON: ${message}` };
  }
}

/**
 * Decide which checker to use for a file path.
 * Returns null for extensions we don't validate (TS family + everything
 * else) — those fixes are accepted without syntax checking.
 */
function pickChecker(filePath) {
  const lower = String(filePath || '').toLowerCase();
  if (lower.endsWith('.json')) return checkJsonSyntax;
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return checkJsSyntax;
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) {
    return (src) => checkTsSyntax(src, 'fix-validation.ts');
  }
  if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) {
    return (src) => checkTsSyntax(src, 'fix-validation.tsx');
  }
  return null;
}

/**
 * Run the syntax gate against a collection of fixes.
 *
 * @param {Object} opts
 * @param {Array<{ file: string, fixed: string, original: string, issues: string[] }>} opts.fixes
 *        Output of the per-file iterative fix loop.
 * @param {Object} [opts.checkers]
 *        Optional override of the checkers used for each language —
 *        primarily for tests. Shape: { js, json }. Defaults to the
 *        built-in vm.compileFunction / JSON.parse implementations.
 * @returns {{
 *   accepted: Array<{ file, fixed, original, issues }>,
 *   rejected: Array<{ file, fixed, original, issues, reason, language }>,
 * }}
 */
function validateFixesSyntax(opts) {
  const { fixes, checkers } = opts || {};
  if (!Array.isArray(fixes)) throw new TypeError('fixes must be an array');

  const jsChecker = (checkers && checkers.js) || checkJsSyntax;
  const jsonChecker = (checkers && checkers.json) || checkJsonSyntax;
  const tsChecker = (checkers && checkers.ts) || checkTsSyntax;

  const accepted = [];
  const rejected = [];

  for (const fix of fixes) {
    if (!fix || typeof fix.file !== 'string' || typeof fix.fixed !== 'string') {
      rejected.push({ ...(fix || {}), reason: 'malformed fix entry', language: 'unknown' });
      continue;
    }

    const lower = fix.file.toLowerCase();
    let checker;
    let language;
    if (lower.endsWith('.json')) { checker = jsonChecker; language = 'json'; }
    else if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) { checker = jsChecker; language = 'js'; }
    else if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) {
      checker = tsChecker; language = 'ts';
    } else if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) {
      checker = (src) => tsChecker(src, 'fix-validation.tsx'); language = 'tsx';
    } else { checker = null; language = 'unchecked'; }

    if (!checker) {
      // No checker for this extension — pass through. The accepted
      // entry preserves a `language` field so the PR body can note
      // which fixes were syntax-gated and which were not.
      accepted.push({ ...fix, language });
      continue;
    }

    const result = checker(fix.fixed);
    if (result.ok) {
      accepted.push({
        ...fix,
        language,
        ...(result.unverified ? { unverified: true, unverifiedReason: result.reason } : {}),
      });
    } else {
      rejected.push({ ...fix, reason: result.reason, language });
    }
  }

  return { accepted, rejected };
}

/**
 * Summarise gate results for log lines and PR-body footnotes.
 */
function summariseSyntaxGate(result) {
  if (!result) return 'syntax gate: not run';
  const { accepted = [], rejected = [] } = result;
  const total = accepted.length + rejected.length;
  if (total === 0) return 'syntax gate: 0 fixes';

  // "validated, all clean" must mean something was actually parsed. When the
  // TS compiler is missing every .ts/.tsx fix passes unchecked, and saying
  // "all clean" over those is a claim we have not earned.
  const unverified = accepted.filter((a) => a && a.unverified);
  const unverifiedNote = unverified.length
    ? ` — ${unverified.length} NOT syntax-checked (${unverified[0].unverifiedReason || 'checker unavailable'}): ${unverified.map((u) => u.file).join(', ')}`
    : '';

  if (rejected.length === 0) {
    if (unverified.length === 0) {
      return `syntax gate: ${total} fix${total > 1 ? 'es' : ''} validated, all clean`;
    }
    const checked = total - unverified.length;
    if (checked === 0) return `syntax gate: ${total} fix${total > 1 ? 'es' : ''} accepted but NONE verified${unverifiedNote}`;
    return `syntax gate: ${checked}/${total} validated, all clean${unverifiedNote}`;
  }
  const failedFiles = rejected.map((r) => r.file).join(', ');
  return `syntax gate: ${accepted.length}/${total} clean, ${rejected.length} rejected (${failedFiles})${unverifiedNote}`;
}

module.exports = {
  validateFixesSyntax,
  summariseSyntaxGate,
  // Exported for tests / advanced callers that want to drive a
  // single-file check without going through the gate orchestrator.
  checkJsSyntax,
  checkJsonSyntax,
  checkTsSyntax,
  pickChecker,
};
