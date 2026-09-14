'use strict';

/**
 * CLI argument parsing for `bin/gatetest.js`.
 *
 * WHY THIS IS A MODULE AND NOT A FUNCTION INSIDE THE BIN
 * -----------------------------------------------------
 * `bin/gatetest.js` calls `main()` at import time and exports nothing, so
 * anything defined in it is unreachable from a test. The parser lived there
 * and was therefore never unit-tested — which is how the bug below survived.
 *
 * THE BUG (found 2026-08-29)
 * --------------------------
 * The parser was a bare `else if` chain with NO final `else`, so any token it
 * did not recognise was silently discarded. Verified against the shipped CLI:
 *
 *     $ gatetest --suite quick --report-only --path /nope --bogus-flag-abc
 *     (runs a completely normal scan; not one word about either flag)
 *
 * For a tool whose entire job is refusing to let bad things through, silently
 * ignoring the operator's instructions is the worst available failure mode.
 * Three ways it bit, all of them quiet:
 *
 *   1. A typo — `--report-onlyy` — runs a BLOCKING scan when the operator
 *      asked for advisory. In CI that fails a build nobody meant to gate.
 *      The inverse, `--strictt`, silently does NOT enforce: a green that
 *      cannot turn red.
 *   2. `--suite=quick`, the `=` form most CLIs accept, was ignored whole, so
 *      the scan silently ran the DEFAULT suite. The operator believes they
 *      ran a quick scan; they ran a standard one.
 *   3. A value flag with its value missing (`gatetest --suite`) hit the
 *      `&& argv[i + 1]` guard, failed it, and fell out of the chain — again
 *      silently running the default.
 *
 * This is the same class as the `.gatetest.json` unknown-key warning shipped
 * in 21ea14b7: configuration that looks applied and is not.
 *
 * THE FIX
 * -------
 * The flag table below is the SINGLE source of truth — the parser is driven
 * from it, so the "known flags" list cannot drift from the flags that
 * actually work. (Keeping a hand-written second list is exactly the
 * duplicated-helper trap that KI #77 documents.) Anything unmatched is
 * collected into `unknownArgs` / `missingValues` and reported by the caller.
 *
 * Reporting is ADVISORY by default, matching the config-key precedent: a
 * stray argument from a wrapper script must never cost someone their scan.
 * The point is that it can no longer be silent. Under `--strict` or in CI
 * it IS fatal (exit 2) — see argProblemsAreFatal for why those two
 * contexts are different.
 */

/**
 * Every flag the CLI accepts.
 *
 *   flags  — the accepted tokens (aliases included)
 *   key    — the property set on the parsed args object
 *   type   — 'boolean' | 'value' | 'append' | 'int' | 'float01'
 *   also   — extra keys set to `true` alongside `key` (for --doctor-quick)
 *
 * `key` is NOT always the camel-cased flag: `--stop-first` writes
 * `args['stop-first']`. Preserved exactly as the original chain had it.
 */
const FLAG_SPEC = [
  { flags: ['--help', '-h'], key: 'help', type: 'boolean' },
  { flags: ['--version', '-v'], key: 'version', type: 'boolean' },
  { flags: ['--validate'], key: 'validate', type: 'boolean' },
  { flags: ['--list'], key: 'list', type: 'boolean' },
  { flags: ['--report'], key: 'report', type: 'boolean' },
  { flags: ['--noise'], key: 'noise', type: 'boolean' },
  { flags: ['--all'], key: 'all', type: 'boolean' },
  { flags: ['--init'], key: 'init', type: 'boolean' },
  { flags: ['--init-claude-md'], key: 'initClaudeMd', type: 'boolean' },
  { flags: ['--health'], key: 'health', type: 'boolean' },
  { flags: ['--doctor'], key: 'doctor', type: 'boolean' },
  { flags: ['--doctor-quick'], key: 'doctorQuick', type: 'boolean', also: ['doctor'] },
  { flags: ['--parallel'], key: 'parallel', type: 'boolean' },
  { flags: ['--github-annotations'], key: 'githubAnnotations', type: 'boolean' },
  { flags: ['--stop-first'], key: 'stop-first', type: 'boolean' },
  { flags: ['--fix'], key: 'fix', type: 'boolean' },
  { flags: ['--auto-pr'], key: 'autoPr', type: 'boolean' },
  { flags: ['--pr'], key: 'pr', type: 'boolean' },
  { flags: ['--diff'], key: 'diff', type: 'boolean' },
  { flags: ['--report-only'], key: 'reportOnly', type: 'boolean' },
  { flags: ['--strict'], key: 'strict', type: 'boolean' },
  { flags: ['--baseline'], key: 'baseline', type: 'boolean' },
  { flags: ['--watch'], key: 'watch', type: 'boolean' },
  { flags: ['--sarif'], key: 'sarif', type: 'boolean' },
  { flags: ['--junit'], key: 'junit', type: 'boolean' },
  { flags: ['--offline'], key: 'offline', type: 'boolean' },
  { flags: ['--compliance'], key: 'compliance', type: 'boolean' },
  { flags: ['--feedback'], key: 'feedback', type: 'boolean' },
  { flags: ['--monitor-heal'], key: 'monitorHeal', type: 'boolean' },

  { flags: ['--auto-pr-base'], key: 'autoPrBase', type: 'value' },
  { flags: ['--auto-pr-branch'], key: 'autoPrBranch', type: 'value' },
  { flags: ['--model'], key: 'model', type: 'value' },
  { flags: ['--since'], key: 'since', type: 'value' },
  { flags: ['--ci-init'], key: 'ciInit', type: 'value' },
  { flags: ['--suite'], key: 'suite', type: 'value' },
  { flags: ['--module'], key: 'module', type: 'value' },
  { flags: ['--project'], key: 'project', type: 'value' },
  { flags: ['--server'], key: 'server', type: 'value' },
  { flags: ['--crawl'], key: 'crawl', type: 'value' },
  { flags: ['--crawl-loop'], key: 'crawlLoop', type: 'value' },
  { flags: ['--crawl-cookie'], key: 'crawlCookie', type: 'value' },
  { flags: ['--crawl-storage-state'], key: 'crawlStorageState', type: 'value' },
  { flags: ['--diagnose'], key: 'diagnose', type: 'value' },
  { flags: ['--monitor'], key: 'monitor', type: 'value' },
  { flags: ['--flush'], key: 'flush', type: 'value' },

  { flags: ['--skip-module'], key: 'skipModules', type: 'append' },
  { flags: ['--crawl-header'], key: 'crawlHeaders', type: 'append' },

  { flags: ['--crawl-max'], key: 'crawlMax', type: 'int' },
  { flags: ['--monitor-interval'], key: 'monitorInterval', type: 'int' },
  { flags: ['--confidence-threshold'], key: 'confidenceThreshold', type: 'float01' },
];

/** token -> spec. Built once from FLAG_SPEC so the two cannot drift. */
const BY_TOKEN = new Map();
for (const spec of FLAG_SPEC) {
  for (const f of spec.flags) BY_TOKEN.set(f, spec);
}

/** Every accepted token, for the caller's "did you mean" and for tests. */
const KNOWN_FLAGS = [...BY_TOKEN.keys()];

/**
 * Levenshtein distance, capped for short CLI tokens. Used only to suggest a
 * near-miss; never to guess on the operator's behalf. Silently "correcting"
 * a flag would be a worse failure than ignoring it.
 */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Closest known flag to `token`, or null when nothing is close enough.
 * The threshold scales with length so `--al` doesn't match half the table.
 */
function suggestFlag(token) {
  const bare = String(token).replace(/=.*$/, '');
  let best = null;
  let bestDist = Infinity;
  for (const known of KNOWN_FLAGS) {
    const d = editDistance(bare, known);
    if (d < bestDist) {
      bestDist = d;
      best = known;
    }
  }
  const limit = bare.length <= 6 ? 2 : 3;
  return bestDist <= limit ? best : null;
}

/**
 * Parse CLI argv.
 *
 * Returns the args object the CLI has always returned, plus three
 * non-enumerable-by-convention diagnostic keys the caller reports on:
 *
 *   unknownArgs   — tokens matching nothing, each with a suggestion
 *   missingValues — known flags used without their required value
 *   invalidValues — known flags whose value failed validation
 *
 * All three are advisory. The scan still runs; it just no longer runs while
 * pretending the operator said nothing.
 */
function parseArgs(argv) {
  const args = {};
  const unknownArgs = [];
  const missingValues = [];
  const invalidValues = [];

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];

    // Support `--flag=value` as well as `--flag value`. Previously the `=`
    // form matched nothing and was dropped, silently running defaults.
    let token = raw;
    let inlineValue = null;
    const eq = typeof raw === 'string' ? raw.indexOf('=') : -1;
    if (eq > 2 && raw.startsWith('--')) {
      token = raw.slice(0, eq);
      inlineValue = raw.slice(eq + 1);
    }

    const spec = BY_TOKEN.get(token);
    if (!spec) {
      unknownArgs.push({ arg: raw, suggestion: suggestFlag(raw) });
      continue;
    }

    if (spec.type === 'boolean') {
      // `--strict=false` is not a thing here; flag presence is the signal.
      // Say so rather than quietly treating it as `--strict`.
      if (inlineValue !== null) {
        invalidValues.push({ arg: token, value: inlineValue, reason: 'takes no value' });
        continue;
      }
      args[spec.key] = true;
      for (const extra of spec.also || []) args[extra] = true;
      continue;
    }

    // Every remaining type needs a value.
    let value = inlineValue;
    if (value === null) {
      const next = argv[i + 1];
      // A value flag must not swallow the FOLLOWING FLAG as its value.
      // `gatetest --suite --report-only` used to set suite="--report-only"
      // and consume --report-only entirely, so the operator got the default
      // suite AND a blocking scan they had asked to be advisory — two silent
      // wrongs from one omitted word. Only a KNOWN flag token counts as the
      // boundary, so legitimate values that merely begin with "-" still work.
      // A misspelled flag counts too — `--suite --bogus` should report BOTH
      // problems, not quietly scan a suite named "--bogus".
      const nextIsFlag = typeof next === 'string' && next.startsWith('--');
      if (i + 1 >= argv.length || nextIsFlag) {
        missingValues.push(token);
        continue;
      }
      value = argv[++i];
    }

    if (spec.type === 'value') {
      args[spec.key] = value;
    } else if (spec.type === 'append') {
      (args[spec.key] = args[spec.key] || []).push(value);
    } else if (spec.type === 'int') {
      const n = parseInt(value, 10);
      if (Number.isNaN(n)) invalidValues.push({ arg: token, value, reason: 'expects a number' });
      else args[spec.key] = n;
    } else if (spec.type === 'float01') {
      const n = parseFloat(value);
      if (Number.isNaN(n) || n < 0 || n > 1) {
        invalidValues.push({ arg: token, value, reason: 'expects a number between 0 and 1' });
      } else {
        args[spec.key] = n;
      }
    }
  }

  if (unknownArgs.length) args.unknownArgs = unknownArgs;
  if (missingValues.length) args.missingValues = missingValues;
  if (invalidValues.length) args.invalidValues = invalidValues;
  return args;
}

/** Did `parseArgs` collect anything it could not apply? */
function hasArgProblems(args) {
  return Boolean(
    (args.unknownArgs && args.unknownArgs.length)
    || (args.missingValues && args.missingValues.length)
    || (args.invalidValues && args.invalidValues.length)
  );
}

/**
 * Is an argument the parser could not apply a USAGE ERROR for this run?
 *
 * Advisory-by-default stands (see the module header): on a developer's
 * machine a stray token from a wrapper script must not cost them their scan.
 * Two contexts flip that, because in both the operator has said "do not
 * guess on my behalf":
 *
 *   --strict        the operator asked for enforcement. A `--strict` scan
 *                   that quietly ran the DEFAULT suite because `--suite` lost
 *                   its value is the green-that-cannot-turn-red the header
 *                   describes, now with the operator's own flag on it.
 *   CI              nobody is watching stderr. `gatetest --bogus-flag` in a
 *                   workflow printed one warning line into a 2,000-line log
 *                   and exited 0 (reproduced 2026-09-14); a passing check
 *                   whose command line was partly ignored is not a pass.
 *
 * Missing and invalid values count as well as unknown flags: `--suite` with
 * no value and `--suite=quikc` are the same mistake wearing different
 * clothes, and the parser already reports all three together.
 *
 * `env` is injectable so the CI branch is testable without mutating
 * process.env in a test that other tests share a process with.
 */
function argProblemsAreFatal(args, env = process.env) {
  if (!hasArgProblems(args)) return false;
  if (args.strict === true) return true;
  const ci = env && env.CI;
  return Boolean(ci) && String(ci).toLowerCase() !== 'false' && String(ci) !== '0';
}

/**
 * Render the lines for whatever `parseArgs` could not use.
 * Returns [] when everything was understood, so the caller prints nothing.
 *
 * `fatal` changes the wording, not the list: when the caller is about to
 * exit 2 the lines must not say "ignored, so the default applies" — nothing
 * is going to run. See argProblemsAreFatal for when that is.
 *
 * Kept separate from printing so it can be asserted in tests without
 * capturing stderr.
 */
function describeArgProblems(args, { fatal = false } = {}) {
  const lines = [];
  const level = fatal ? 'Error' : 'Warning';
  const dropped = fatal ? 'refused' : 'ignored';
  const defaulted = fatal ? 'refused' : 'ignored, so the default applies';
  for (const { arg, suggestion } of args.unknownArgs || []) {
    lines.push(
      `[GateTest] ${level}: unknown option "${arg}" — ${dropped}.` +
        (suggestion ? ` Did you mean "${suggestion}"?` : '')
    );
  }
  for (const flag of args.missingValues || []) {
    lines.push(`[GateTest] ${level}: "${flag}" needs a value — ${defaulted}.`);
  }
  for (const { arg, value, reason } of args.invalidValues || []) {
    lines.push(`[GateTest] ${level}: "${arg}" ${reason} (got "${value}") — ${defaulted}.`);
  }
  if (lines.length && fatal) {
    lines.push(`[GateTest] Usage error: arguments that cannot be applied are fatal under --strict and in CI (${USAGE_EXIT_CODE_NAME}). Nothing was scanned.`);
  }
  if (lines.length) lines.push('[GateTest] Run "gatetest --help" for the full option list.');
  return lines;
}

/**
 * Exit code for "the command line itself is wrong" — the same 2 that
 * `gatetest verify-report` and `gatetest fix` (offline) already use, and
 * the one every POSIX tool uses, so a wrapper can tell "the gate blocked"
 * (1) from "your invocation is broken" (2).
 */
const USAGE_EXIT_CODE = 2;
const USAGE_EXIT_CODE_NAME = `exit ${USAGE_EXIT_CODE}`;

/**
 * Why `--project <path>` cannot be scanned, or null when it can.
 *
 * Reproduced 2026-09-14: `gatetest --project ./does-not-exist --suite quick`
 * printed `GATE: PASSED  Modules: 42/42 passed`, exited 0, and CREATED the
 * directory (plus `.gatetest/reports/` under it) so the report writer had
 * somewhere to put the report of nothing. A gate that passes a path that
 * does not exist passes anything; a typo in a CI `--project` was green.
 *
 * `fsImpl` is injectable for tests. The path is resolved against cwd the
 * same way the scan would resolve it.
 */
function projectPathProblem(projectPath, fsImpl = require('fs')) {
  const path = require('path');
  if (typeof projectPath !== 'string' || projectPath.trim() === '') {
    return '--project needs a path';
  }
  const abs = path.resolve(projectPath);
  let stat;
  try {
    stat = fsImpl.statSync(abs);
  } catch (err) {
    if (err && err.code === 'ENOENT') return `project path does not exist: ${abs}`;
    return `project path cannot be read: ${abs} (${err && err.message ? err.message : err})`;
  }
  if (!stat.isDirectory()) return `project path is not a directory: ${abs}`;
  return null;
}

module.exports = {
  parseArgs,
  describeArgProblems,
  hasArgProblems,
  argProblemsAreFatal,
  projectPathProblem,
  suggestFlag,
  KNOWN_FLAGS,
  FLAG_SPEC,
  USAGE_EXIT_CODE,
};
