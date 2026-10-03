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

/**
 * Teardown of something that may already be gone, and read-only diagnostics
 * printed for a human. `|| true` on these is a warning, not a blocked build:
 * `systemctl stop caddy || true` before installing the replacement, `userdel
 * old-user || true` in an uninstaller, `journalctl -u svc -n 30 || true` in a
 * failure report. A failure leaves nothing the script goes on to rely on.
 * (Tallrig 2026-10-03: 103 teardown + 24 diagnostic lines of 229.)
 * NOT here, and blocking: anything that brings state INTO being —
 * `systemctl start|restart|enable|reload`, `rsync`, `cp`, `tar`,
 * `git reset`, `bun install` (Tallrig deploy.sh rollback hid all four).
 */
const TEARDOWN_OR_READONLY = new Set([
  'systemctl stop', 'systemctl disable', 'systemctl mask', 'systemctl unmask',
  'systemctl reset-failed', 'systemctl kill', 'systemctl show', 'systemctl status',
  'systemctl is-active', 'systemctl is-enabled', 'systemctl is-failed',
  'ufw delete', 'docker rm', 'docker stop', 'docker kill', 'docker rmi',
  'git remote rm', 'git remote remove', 'nft list', 'wg show', 'ip link',
  'userdel', 'groupdel', 'pkill', 'killall', 'fuser', 'rm', 'rmdir', 'unlink',
  'journalctl', 'dmesg', 'dig', 'ss', 'ls', 'df', 'free', 'uptime',
]);

/**
 * A YAML step whose `name:`/`id:` says it is CI plumbing, never the
 * product's own test/build/gate — AlecRae.com's standalone-deploy.yml
 * (issue #771, GT-13) posts its gate result to a flywheel endpoint under a
 * "report" step with `|| true`: `|| true` on an "Upload coverage" / "Post PR
 * comment" / "Report result" step is a warning, not a blocked build.
 * Control pair below: `name: "Upload coverage"` / `run: npx codecov ||
 * true` is a warning; an unnamed `run: npm test || true` still fires as an
 * error. The shell shapes that made up most of GT-13's count are
 * METADATA_ONLY_CMDS and `_selfReportingFunction` below.
 */
const BEST_EFFORT_STEP_RE = /upload|artifact|cache|comment|notify|coverage|report|lint-annot|summary|telemetry|badge/i;

/**
 * Commands that run the product's own tests, build, or the gate itself —
 * these stay blocking even when the step's `name:`/`id:` also matches
 * BEST_EFFORT_STEP_RE (a step named "Test and report failures" is still the
 * gate; the NAME does not override what the line actually runs). Checked
 * against the masked line so a quoted string can't earn the downgrade.
 */
const GATE_COMMAND_RE = /\b(?:npm|yarn|pnpm)\s+(?:run\s+)?(?:test|build)\b|\b(?:jest|vitest|mocha|ava|pytest|tox|rspec)\b|\bgo\s+test\b|\bcargo\s+(?:test|build)\b|\bmake\s+(?:test|build)\b|\btsc\b|\bnext\s+build\b|\bwebpack\b|\bgatetest\b/i;

/**
 * Commands that only touch a file's METADATA — permission bits, owner,
 * mtime. Whether `chmod 644 "$STATUS_FILE" 2>/dev/null || true` succeeds or
 * not, the file's contents and every later line of the script are the same;
 * the one consumer that needs the permission (another service reading the
 * file) fails on its own, visibly, at read time. AlecRae.com (issue #771,
 * GT-13) carried this exact line in three deploy-status scripts and each
 * was a blocking finding. Worth a warning — the customer is still told —
 * never a blocked build. The list is deliberately metadata-only: `cp`,
 * `mkdir`, `rm` and `exec N>` change what the script goes on to read
 * (`exec 9>"$LOCK" || true` + `flock -n 9` skips a deploy for good when the
 * lock dir is missing — the same script, kept blocking as the control).
 */
const METADATA_ONLY_CMDS = new Set(['chmod', 'chown', 'chgrp', 'touch']);

/**
 * An HTTP call whose response nothing reads: `curl -fsS "$PING_URL" >/dev/null
 * 2>&1 || true`. Gluecron's heartbeat workflow and auto-update.sh carry it on
 * health-check pings and deploy-event POSTs (2026-10-02: 9 of 69 blocking
 * bashSafety findings). Whether the ping lands or not, the script reads
 * nothing from it and goes on identically — a warning, never a blocked
 * build. Only when the body is discarded (`>/dev/null`, `-o /dev/null`) and
 * NOT piped on (`curl … | sh`) or saved to a file the script later reads
 * (`-o file`): those keep blocking. The command is read whole, across `\`
 * continuations, because the URL line is often not the one with `|| true`.
 */
const NOTIFY_CMD_RE = /^\s*(?:docker\s+exec\s+(?:-\S+\s+)*[\w.-]+\s+)?(?:curl|wget)\b/;
function discardedHttpCall(command) {
  if (!NOTIFY_CMD_RE.test(command)) return false;
  if (/\|(?!\|)/.test(command.replace(/\|\|\s*true\b.*$/, ''))) return false;
  const discards = /(?:^|\s)(?:>|1>)\s*\/dev\/null\b|\s(?:-o|--output|-O)\s+\/dev\/null\b|\s-q\s+-O-?\s*\/dev\/null/.test(command);
  const savesFile = /\s(?:-o|--output|-O|--output-document)\s+(?!\/dev\/null\b)\S/.test(command);
  return discards && !savesFile;
}

/**
 * `^name() {` / `^function name {` — a function defined in THIS script.
 * `_selfReportingFunction` reads its body to decide whether `name … ||
 * true` is a swallow or the author keeping `set -e` from aborting a check
 * that has already printed its own verdict (AlecRae.com health-check.sh:
 * `check_tcp … || true` where `check_tcp` calls `check_fail` on the miss).
 */
const FUNCTION_DEF_RE = /^\s*(?:function\s+([A-Za-z_][\w-]*)\s*(?:\(\s*\))?|([A-Za-z_][\w-]*)\s*\(\s*\))\s*\{?\s*$/;
/** A body line that puts the outcome in front of the reader. */
const REPORTS_OUTCOME_RE = /\b(?:echo|printf|logger)\b|\blog(?:_\w+)?\b|\b\w+_(?:fail|failed|warn|error|pass|ok)\b|>&2/;

const DEVNULL_SWALLOW_RE = /2>\/dev\/null\s*\|\|\s*true\b/;

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
    pattern: DEVNULL_SWALLOW_RE,
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
  const three = `${two} ${words[2] || ''}`.trim();
  if (TEARDOWN_OR_READONLY.has(three)) return three;
  if (TEARDOWN_OR_READONLY.has(two)) return two;
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
        // `2>/dev/null || true` is reported once, as devnull-swallow — the
        // same line under pipe-true too doubled every such finding.
        if (rule.code === 'pipe-true' && DEVNULL_SWALLOW_RE.test(codeLine)) continue;
        if (rule.code === 'set-e-disabled' && this._errexitHandled(lines, idx, mode)) continue;

        // `message` + rel path + line are what the finding registry, the
        // confidence scorer and the PR comment consume — this module used
        // to emit only `fix` with an absolute path, which surfaced as
        // `message: null` findings (2026-08-18 audit residue).
        const inspected = rule.swallowGuard && this._capturedForInspection(lines, idx, mode);
        const tested = !inspected && rule.swallowGuard && this._outcomeTestedBelow(lines, idx, mode);
        // GT-13 (issue #771): a `|| true` on a best-effort CI step (upload,
        // artifact, cache, comment, notify, coverage, report, telemetry,
        // badge...) is a warning, not a blocked build — UNLESS the guarded
        // line is itself the command that runs tests/build/the gate, which
        // always stays blocking regardless of the step's name.
        const bestEffort = !inspected && !tested && rule.swallowGuard && mode === 'yaml'
          && !GATE_COMMAND_RE.test(codeLine)
          && this._isBestEffortStep(lines, idx);
        // GT-13 (issue #771), the two shell shapes from AlecRae's scripts:
        // a metadata-only command (chmod/chown/chgrp/touch) whose failure
        // changes nothing the script goes on to do, and a function defined
        // in this file that prints its own verdict before returning non-zero.
        const guardedHead = rule.swallowGuard && !inspected && !tested && !bestEffort
          ? guardedCommandHead(codeLine) : null;
        const metadataOnly = guardedHead !== null && METADATA_ONLY_CMDS.has(guardedHead);
        // Head read from the whole `\`-continued command, so a `|| true` on
        // a continuation line is judged by the command it belongs to.
        const contHead = rule.swallowGuard && !inspected && !tested && !bestEffort && !metadataOnly
          ? guardedCommandHead(this._continuedCommand(lines, idx)) : null;
        const teardown = contHead !== null && TEARDOWN_OR_READONLY.has(contHead);
        const notifyOnly = rule.swallowGuard && !inspected && !tested && !bestEffort && !metadataOnly && !teardown
          && discardedHttpCall(this._continuedCommand(lines, idx));
        const selfReporting = guardedHead !== null && !metadataOnly && !teardown && !notifyOnly && this._selfReportingFunction(lines, guardedHead);
        const downgraded = inspected || tested || bestEffort || metadataOnly || teardown || notifyOnly || selfReporting;
        result.addCheck(`bash-safety:${rule.code}:${rel}:${lineNum}`, false, {
          severity: downgraded ? 'warning' : rule.severity,
          file: rel,
          line: lineNum,
          message: rule.message(rawLine)
            + (inspected ? ' — the captured output is read below; make sure an empty result on failure is not treated as success' : '')
            + (tested ? ' — the outcome is tested on the next line; make sure that test covers the failure, not only the happy path' : '')
            + (bestEffort ? ' — step name/id marks this as best-effort CI plumbing (upload/artifact/cache/coverage/notify/report/...); it does not gate the build' : '')
            + (metadataOnly ? ` — ${guardedHead} only changes file metadata; a failure leaves the script's data and control flow unchanged, so this is best-effort, not a swallowed error` : '')
            + (teardown ? ` — ${contHead} removes or only reads something; a failure leaves nothing the script goes on to rely on` : '')
            + (notifyOnly ? ' — an HTTP call whose response is discarded (a ping or event post); the script reads nothing from it, so a failure changes nothing that follows' : '')
            + (selfReporting ? ` — ${guardedHead} is defined in this file and prints its own verdict before returning non-zero; the "|| true" keeps set -e from aborting the remaining checks` : ''),
          fix: `${rel}:${lineNum} — ${rule.message(rawLine)}\nFix: handle the error explicitly or add "# gatetest:swallow-ok reason=\\"<reason>\\"" if intentional.`,
        });
      }
    });
  }

  /** The command ending at `idx`, joined back across `\` line continuations, literals stripped. */
  _continuedCommand(lines, idx) {
    let start = idx;
    while (start > 0 && /\\\s*$/.test(lines[start - 1]) && idx - start < 12) start -= 1;
    return lines.slice(start, idx + 1).map((l) => stripShellLiterals(l).replace(/\\\s*$/, ' ')).join(' ')
      .replace(/^\s*(?:-\s+)?(?:run:\s*\|?\s*)?/, '');
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

  /**
   * The YAML `run:` key line that owns line `idx` — `idx` itself when it IS
   * the `run:` line (single-line `run: cmd` or the `run: |` header), or the
   * `run:` line above when `idx` is a content line inside its block scalar.
   * Mirrors `_isInRunBlock`'s upward walk but returns the line index instead
   * of a boolean, so callers can inspect the step that OWNS the block.
   */
  _runKeyLineIndex(lines, idx) {
    const cur = lines[idx] || '';
    if (!cur.trim()) return null;
    if (RUN_KEY_RE.test(cur)) return idx;
    let minIndent = cur.match(/^\s*/)[0].length;
    for (let i = idx - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l.trim()) continue;
      const indent = l.match(/^\s*/)[0].length;
      if (indent >= minIndent) continue;
      minIndent = indent;
      if (RUN_KEY_RE.test(l)) return /^\s*(?:-\s+)?run:\s*[|>]/.test(l) ? i : null;
      if (YAML_STRUCTURAL_RE.test(l)) return null;
    }
    return null;
  }

  /**
   * The `name:`/`id:` text of the YAML step that owns the run: line at
   * `idx` — walked back to the step's own `- ` boundary in the `steps:`
   * list. A step is:
   *   - name: Upload coverage
   *     id: cov
   *     run: npx codecov || true
   * `name:`/`id:` are siblings of `run:` at the step's field indent; a
   * shallower line or the step's own `- ` opener ends the search. Returns
   * '' when `run:` itself opens the step (`- run: cmd` — nothing can
   * precede it in the same step) or when idx isn't inside a run: block.
   */
  _stepLabel(lines, idx) {
    const runIdx = this._runKeyLineIndex(lines, idx);
    if (runIdx === null) return '';
    const cur = lines[runIdx];
    if (/^\s*-\s+/.test(cur)) return ''; // run: opens the step — no name/id before it
    const fieldIndent = cur.match(/^(\s*)/)[0].length;
    let label = '';
    for (let i = runIdx - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l.trim()) continue;
      const d = l.match(/^(\s*)-\s+/);
      const indent = d ? d[0].length : l.match(/^(\s*)/)[0].length;
      if (indent > fieldIndent) continue;  // content of an earlier multi-line field
      if (indent < fieldIndent) break;     // stepped out of this step entirely
      const m = l.match(/^\s*(?:-\s+)?(?:name|id)\s*:\s*(.+)$/);
      if (m) label += ` ${m[1].trim().replace(/^['"]|['"]$/g, '')}`;
      if (d) break; // this line opened the step — nothing further back is ours
    }
    return label.trim();
  }

  _isBestEffortStep(lines, idx) {
    return BEST_EFFORT_STEP_RE.test(this._stepLabel(lines, idx));
  }

  /**
   * `head` is a function defined in this file whose body reports its own
   * outcome (echo, printf, log_…, check_fail, `>&2`) — so `head … || true` is
   * the author keeping `set -e` alive after a check that has already told
   * the reader it failed, not a failure hidden from them. A function whose
   * body only runs commands (`deploy() { ssh box git pull; }`) reports
   * nothing, and `deploy || true` stays the swallow it is. The body is read
   * up to the closing `}` at the definition's own indent; a definition
   * without a body in this file (sourced from elsewhere) is not trusted.
   */
  _selfReportingFunction(lines, head) {
    if (!/^[A-Za-z_][\w-]*$/.test(head)) return false;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(FUNCTION_DEF_RE);
      if (!m || (m[1] || m[2]) !== head) continue;
      const defIndent = lines[i].match(/^\s*/)[0].length;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim()) continue;
        if (l.match(/^\s*/)[0].length <= defIndent && /^\s*\}/.test(l)) return false;
        if (REPORTS_OUTCOME_RE.test(stripShellLiterals(l))) return true;
      }
      return false;
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
