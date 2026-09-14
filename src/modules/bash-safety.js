/**
 * Bash Safety Module — detects error-swallowing patterns in shell scripts,
 * CI YAML run: blocks, and package.json scripts.
 * Flags: || true, 2>/dev/null || true, set +e without set -e, ; true.
 * Requires explicit // gatetest:swallow-ok reason="..." justification.
 */

const BaseModule = require('./base-module');
const { stripShellLiterals } = require('../core/source-strip');
const { collectShellScripts } = require('../core/shell-files');
const fs   = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');

const SWALLOW_OK = /gatetest:swallow-ok/;
/** `[ -d x ]`, `[[ ! -f x ]]`, `test -s x`, `if ! [ -e x ]`, `$?` — a decision on the artefact. */
const OUTCOME_TEST_RE = /(?:^|\s|!)(?:\[\[?\s+!?\s*-[a-zA-Z]\s|test\s+!?\s*-[a-zA-Z]\s)|\$\?/;

// Which files are shell scripts is decided ONCE in src/core/shell-files.js
// (KI #106): `.sh`/`.bash`/`.zsh`/`.ksh` plus extensionless shebang scripts.
// This module's private list used to be `['.sh', '.bash']` — no `.zsh`, and
// `bin/deploy` with `#!/usr/bin/env bash` on line one was never opened.
const YAML_EXTS = ['.yml', '.yaml'];
// `run:` as a YAML key (optionally a list item), and any YAML key / list item —
// the two shapes `_isInRunBlock` distinguishes when walking out of a block.
const RUN_KEY_RE = /^\s*(?:-\s+)?run:(?:\s|$)/;
const YAML_STRUCTURAL_RE = /^\s*(?:-\s+)?[A-Za-z_][\w.-]*:(?:\s|$)|^\s*-\s/;

/**
 * Commands that use a NON-ZERO EXIT AS AN ANSWER, not as a failure report.
 * `grep` exiting 1 means "no match"; `command -v` exiting 1 means "not
 * installed"; `diff` exiting 1 means "they differ". Under `set -e` every one of
 * these NEEDS `|| true` (or an `if`) to keep the script alive, so flagging them
 * is this module's single largest source of false positives.
 *
 * The list is deliberately short and every entry has that same justification.
 * Anything NOT on it keeps firing at error severity: `node deploy.js || true`
 * is a swallowed error no matter which directory it lives in, and that is the
 * failure this module exists to catch (a swallowed error in
 * scripts/deploy/deploy-on-box.sh let production sit 60 commits stale for six
 * days — see .github/workflows/deploy-box.yml).
 */
const TOLERANT_EXIT = new Set([
  'grep', 'egrep', 'fgrep', 'rg', 'ag',
  'command', 'which', 'type', 'hash',
  'pgrep', 'diff', 'cmp', 'test', '[',
  'jq', 'yq', 'head', 'tail', 'read',
  'git diff', 'git grep', 'git check-ignore', 'git ls-files', 'git show-ref',
  'npm ls', 'docker inspect', 'docker ps',
]);

const RULES = [
  {
    code: 'pipe-true',
    pattern: /\|\|\s*true\b/,
    severity: 'error',
    swallowGuard: true,
    message: (line) => `"|| true" swallows errors — failures are silently ignored: ${line.trim()}`,
  },
  {
    code: 'devnull-swallow',
    pattern: /2>\/dev\/null\s*\|\|\s*true\b/,
    severity: 'error',
    swallowGuard: true,
    message: (line) => `"2>/dev/null || true" hides stderr AND swallows exit code — undetectable failure: ${line.trim()}`,
  },
  {
    code: 'semicolon-true',
    pattern: /;\s*true\s*($|;|\n)/,
    severity: 'error',
    message: (line) => `"; true" resets exit code — pipeline failure becomes success: ${line.trim()}`,
  },
  {
    code: 'set-e-disabled',
    pattern: /\bset\s+\+e\b/,
    severity: 'error',
    message: (line) => `"set +e" disables error exit — subsequent failures are swallowed until "set -e" is restored: ${line.trim()}`,
  },
  {
    code: 'devnull-only',
    pattern: /2>\/dev\/null(?!\s*\|\|)/,
    severity: 'warning',
    message: (line) => `"2>/dev/null" hides error messages — debugging production failures becomes much harder: ${line.trim()}`,
  },
  {
    code: 'ignore-exit',
    pattern: /\bignore_errors:\s*yes\b/i,
    severity: 'error',
    message: (line) => `"ignore_errors: yes" (Ansible) swallows task failures: ${line.trim()}`,
  },
];


/**
 * The head command of the pipeline that `|| true` actually guards — i.e. whose
 * exit status is being replaced. Returns null when it cannot be determined,
 * which is treated as "not tolerant" (fail closed: we would rather report a
 * questionable swallow than miss a real one).
 */
function guardedCommandHead(masked) {
  const at = masked.search(/\|\|\s*true\b/);
  if (at < 0) return null;
  let seg = masked.slice(0, at)
    .replace(/(^|\s)\d*(>>?|<)\s*\S+/g, ' ')  // drop redirections: > f, 2>/dev/null, 2>&1
    .replace(/[)"']+\s*$/, '');               // drop a closing $( ) / quote
  const parts = seg.split(/\|\||&&|\$\(|[|;&(`]/);
  let last = (parts[parts.length - 1] || '').trim();
  last = last.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');  // FOO=bar cmd
  last = last.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=)/, '');         // VAR=$(cmd
  last = last.replace(/^(?:sudo|env|nice|time|exec|eval|builtin)\s+/, '');
  if (!last) return null;
  const words = last.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const two = `${words[0]} ${words[1] || ''}`.trim();
  if (TOLERANT_EXIT.has(two)) return two;
  return words[0];
}

function isTolerantSwallow(rawLine) {
  const head = guardedCommandHead(stripShellLiterals(rawLine));
  return head !== null && TOLERANT_EXIT.has(head);
}

/**
 * An npm script whose NAME says the step is informational: `coverage`,
 * `test:cov`, `cov:report`. A `|| true` there is the author declaring, in
 * the script's own name, that a coverage run never fails the pipeline — the
 * tests are gated by a script that is not swallowed (nestjs/nest: `"test":
 * "vitest run"` next to `"coverage": "vitest run --coverage ... || true"`,
 * corpus6 2026-09-05). That is worth a warning, not a blocked build.
 *
 * The NAME governs, not the command: `"test": "vitest --coverage || true"`
 * is still the test step going green on red, and stays an error. Segments
 * are split on the separators npm script names use; `recover` and
 * `discovery` do not contain the segment `cov`.
 */
const COVERAGE_SEGMENT_RE = /^(?:cov|coverage)$/i;
function isCoverageScript(name) {
  return String(name).split(/[:_\-.\s]+/).some((s) => COVERAGE_SEGMENT_RE.test(s));
}

/**
 * `VAR=$(cmd) || true` — the exit status is traded for the OUTPUT. Under
 * `set -e` (GitHub Actions' default `bash -e`) a failing assignment aborts
 * the step, so the `|| true` is what lets the next lines read `$VAR` at all.
 * Matched on masked code so a quoted string cannot look like an assignment.
 */
// Both placements of the `|| true` — after the substitution and inside it
// (`origin_url=$(git remote get-url "$R" 2>/dev/null || true)`, ktor's
// switch-base-branch.sh:133) — trade the exit status for the output.
const CAPTURE_SWALLOW_RE = /^\s*(?:export\s+|local\s+)?([A-Za-z_][A-Za-z0-9_]*)=\$\((?:.*\)\s*\|\|\s*true\b|.*\|\|\s*true\s*\))/;

class BashSafetyModule extends BaseModule {
  constructor() { super('bashSafety', 'Bash / Shell Error-Swallow Detector'); }

  async run(result, config) {
    const root = config.projectRoot;

    // One shared walk for both kinds (KI #104) — it replaced a private glob
    // whose exclude test also matched ancestor segments of the project path.
    const { scripts, others: yaml } = collectShellScripts(this, root, YAML_EXTS);

    // Shell scripts
    for (const file of scripts) {
      this._scanFile(file, repoRelative(root, file), result, 'shell');
    }

    // CI YAML — extract run: blocks
    for (const file of yaml) {
      this._scanFile(file, repoRelative(root, file), result, 'yaml');
    }

    // package.json scripts
    const pkgFile = path.join(root, 'package.json');
    if (fs.existsSync(pkgFile)) {
      this._scanPackageJson(pkgFile, result);
    }

    if (result.checks.length === 0 || result.checks.every(c => c.passed)) {
      result.addCheck('bash-safety-clean', true, { severity: 'info', fix: 'No error-swallowing patterns found in shell scripts or CI workflows' });
    }
  }

  _scanFile(file, rel, result, mode) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { return; }

    const lines = content.split(/\r?\n/);
    lines.forEach((rawLine, idx) => {
      const lineNum = idx + 1;

      // Check for suppression comment on the same line or the line above
      const prevLine = idx > 0 ? lines[idx - 1] : '';
      if (SWALLOW_OK.test(rawLine) || SWALLOW_OK.test(prevLine)) return;

      // For YAML, only scan inside run: blocks
      if (mode === 'yaml' && !this._isInRunBlock(lines, idx)) return;

      // Match against CODE only — a comment or a quoted string that happens to
      // contain "|| true" is documentation, not a swallowed error.
      const codeLine = stripShellLiterals(rawLine);

      for (const rule of RULES) {
        if (!rule.pattern.test(codeLine)) continue;
        if (rule.swallowGuard && isTolerantSwallow(rawLine)) continue;
        if (rule.code === 'set-e-disabled' && this._errexitHandled(lines, idx, mode)) continue;

        // `message` + rel path + line are what the finding registry, the
        // confidence scorer and the PR comment consume — this module used
        // to emit only `fix` with an absolute path, which surfaced as
        // `message: null` findings (2026-08-18 audit residue).
        const inspected = rule.swallowGuard && this._capturedForInspection(lines, idx, mode);
        const tested = !inspected && rule.swallowGuard && this._outcomeTestedBelow(lines, idx, mode);
        result.addCheck(`bash-safety:${rule.code}:${rel}:${lineNum}`, false, {
          severity: inspected || tested ? 'warning' : rule.severity,
          file: rel,
          line: lineNum,
          message: rule.message(rawLine)
            + (inspected ? ' — the captured output is read below; make sure an empty result on failure is not treated as success' : '')
            + (tested ? ' — the outcome is tested on the next line; make sure that test covers the failure, not only the happy path' : ''),
          fix: `${rel}:${lineNum} — ${rule.message(rawLine)}\nFix: handle the error explicitly or add "# gatetest:swallow-ok reason=\\"<reason>\\"" if intentional.`,
        });
      }
    });
  }

  _scanPackageJson(file, result) {
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }

    const scripts = pkg.scripts || {};
    for (const [name, cmd] of Object.entries(scripts)) {
      if (typeof cmd !== 'string') continue;
      for (const rule of RULES) {
        if (rule.pattern.test(stripShellLiterals(cmd))) {
          if (rule.swallowGuard && isTolerantSwallow(cmd)) continue;
          const coverage = rule.swallowGuard && isCoverageScript(name);
          result.addCheck(`bash-safety:${rule.code}:package.json:${name}`, false, {
            severity: coverage ? 'warning' : rule.severity,
            file: 'package.json',
            message: `scripts.${name}: ${rule.message(cmd)}` + (coverage ? ' — a coverage step declared non-fatal by its name; keep the tests gated by a script that is not swallowed' : ''),
            fix: `package.json scripts.${name} — ${rule.message(cmd)}\nFix: handle the error or remove the swallow pattern.`,
          });
        }
      }
    }
  }

  /**
   * `set +e` is only a swallow when nothing downstream looks at the exit code.
   * The legitimate pattern — used by every retry/report step in this repo —
   * is: disable errexit, run, capture `$?`, then re-raise it (`exit $code`,
   * `echo "exit_code=$?" >> $GITHUB_OUTPUT`) or restore `set -e`.
   *
   * `$?` is matched against the RAW line because it is usually inside double
   * quotes; `set -e` is matched against masked code so that a COMMENT saying
   * "remember to set -e" cannot buy an exemption.
   */
  _errexitHandled(lines, idx, mode) {
    const limit = Math.min(lines.length, idx + 60);
    for (let i = idx + 1; i < limit; i++) {
      const raw = lines[i];
      // Stop at the next YAML step — a later step's `$?` proves nothing here.
      if (mode === 'yaml' && /^\s*-\s+(name|uses|run|id|if|with|env):/.test(raw)) break;
      if (/\$\?/.test(raw)) return true;
      if (/\bset\s+-[a-zA-Z]*e/.test(stripShellLiterals(raw))) return true;
    }
    return false;
  }

  /**
   * Is this line `VAR=$(cmd) || true` with `$VAR` read on a later line of the
   * same block? Then the exit code was swallowed on purpose so the output
   * could be inspected — trpc's `OUTPUT=$(intent stale --json 2>&1) || true`
   * followed by `echo "$OUTPUT" | node -e ...` (.github/workflows/
   * check-skills.yml:44, corpus6 2026-09-05). Downgraded, not exempted: if
   * the command dies, `$VAR` is empty and a naive reader calls that clean,
   * which is exactly Doctrine §1's shape — so the customer is still told.
   *
   * `$VAR` is matched against RAW lines because it is usually quoted; the
   * assignment is matched against masked code. Stops at the next YAML step.
   */
  _capturedForInspection(lines, idx, mode) {
    const m = CAPTURE_SWALLOW_RE.exec(stripShellLiterals(lines[idx]));
    if (!m) return false;
    const ref = new RegExp(`\\$\\{?${m[1]}\\b`);
    const limit = Math.min(lines.length, idx + 60);
    for (let i = idx + 1; i < limit; i++) {
      if (mode === 'yaml' && /^\s*-\s+(name|uses|run|id|if|with|env):/.test(lines[i])) break;
      if (ref.test(lines[i])) return true;
    }
    return false;
  }

  /**
   * Is the swallowed command's OUTCOME tested within the next three code
   * lines — `[ -d "$DIR/.git" ]`, `test -f …`, `$?`? Then the exit code was
   * swallowed so the script could decide on the artefact instead: our own
   * integrations/husky/pre-push:88 — `git clone … 2>/dev/null || true`
   * followed by `if [ ! -d "$GATETEST_CACHE/.git" ]; then … exit 0`
   * (surfaced the day bashSafety learned to open extensionless hooks, KI
   * #106, 2026-09-05). Downgraded, not exempted, for the same reason as
   * `_capturedForInspection`: the rule cannot see whether the test covers
   * the failure. Blank lines and comments do not count toward the three.
   */
  _outcomeTestedBelow(lines, idx, mode) {
    let seen = 0;
    for (let i = idx + 1; i < lines.length && seen < 3; i++) {
      const raw = lines[i];
      if (mode === 'yaml' && /^\s*-\s+(name|uses|run|id|if|with|env):/.test(raw)) break;
      const code = stripShellLiterals(raw).trim();
      if (!code) continue;
      seen++;
      if (OUTCOME_TEST_RE.test(code)) return true;
    }
    return false;
  }

  _isInRunBlock(lines, idx) {
    // A `run:` block scalar (`run: |`, `run: >`) owns every following line
    // indented deeper than the `run:` key. Walk upward through lines at least
    // as deep as the shallowest line seen so far: a shell line shallower than
    // us (the `if` our `echo` sits in) is still ours; a YAML key or list item
    // shallower than us ends the block — it is `run:` or it is something else.
    //
    // Until 2026-09-05 the walk broke at the first line above that began
    // with a word character, so only the FIRST command of every multi-line
    // run block was scanned; a `|| true` on line two of a step was never
    // seen (this repo's dogfood workflow had two, and its own `ci.yml` was
    // read as clean). Doctrine §1 — the rule reported nothing and looked
    // like a pass.
    const cur = lines[idx] || '';
    if (!cur.trim()) return false;
    if (RUN_KEY_RE.test(cur)) return true;          // `run: cmd || true` on one line
    let minIndent = cur.match(/^\s*/)[0].length;
    for (let i = idx - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l.trim()) continue;
      const indent = l.match(/^\s*/)[0].length;
      if (indent >= minIndent) continue;
      minIndent = indent;
      if (RUN_KEY_RE.test(l)) return /^\s*(?:-\s+)?run:\s*[|>]/.test(l);
      if (YAML_STRUCTURAL_RE.test(l)) return false;   // a shallower key that is not `run:`
    }
    return false;
  }
}

module.exports = BashSafetyModule;
