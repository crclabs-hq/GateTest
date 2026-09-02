/**
 * Bash Safety Module — detects error-swallowing patterns in shell scripts,
 * CI YAML run: blocks, and package.json scripts.
 * Flags: || true, 2>/dev/null || true, set +e without set -e, ; true.
 * Requires explicit // gatetest:swallow-ok reason="..." justification.
 */

const BaseModule = require('./base-module');
const fs   = require('fs');
const path = require('path');

const SWALLOW_OK = /gatetest:swallow-ok/;

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
 * Blank out the CONTENTS of quoted strings and of trailing `#` comments while
 * preserving length, so every pattern below matches shell CODE only.
 *
 * `$( ... )` re-enters code even inside double quotes, because it is code —
 * `NODE_BIN="$(command -v node || true)"` must still be analysed.
 *
 * Without this: a comment explaining why a `|| true` is safe was itself a
 * finding, `echo "|| true"` was a finding, and a jq program containing a
 * literal `|` broke the pipeline splitter below.
 */
function maskNonCode(raw) {
  const stack = [];
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const ctx = stack[stack.length - 1];
    if (ctx === 'sq') {                       // single quotes: nothing expands
      out += c === "'" ? (stack.pop(), c) : ' ';
      continue;
    }
    if (ctx === 'dq') {                       // double quotes: only $( ) is code
      if (c === '\\' && i + 1 < raw.length) { out += '  '; i++; continue; }
      if (c === '"') { stack.pop(); out += c; continue; }
      if (c === '$' && raw[i + 1] === '(') { stack.push('cmd'); out += '$('; i++; continue; }
      out += ' ';
      continue;
    }
    if (c === "'") { stack.push('sq'); out += c; continue; }
    if (c === '"') { stack.push('dq'); out += c; continue; }
    if (c === '$' && raw[i + 1] === '(') { stack.push('cmd'); out += '$('; i++; continue; }
    if (c === ')' && ctx === 'cmd') { stack.pop(); out += c; continue; }
    if (c === '#' && stack.length === 0 && (i === 0 || /[\s;&|(]/.test(raw[i - 1]))) {
      out += ' '.repeat(raw.length - i);
      break;
    }
    out += c;
  }
  return out;
}

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
  const head = guardedCommandHead(maskNonCode(rawLine));
  return head !== null && TOLERANT_EXIT.has(head);
}

class BashSafetyModule extends BaseModule {
  constructor() { super('bashSafety', 'Bash / Shell Error-Swallow Detector'); }

  async run(result, config) {
    const root = config.projectRoot;

    // Shell scripts
    for (const file of this._glob(root, /\.(sh|bash)$/, ['node_modules', '.git', '.claude', '.next', 'dist'])) {
      this._scanFile(file, path.relative(root, file), result, 'shell');
    }

    // CI YAML — extract run: blocks
    for (const file of this._glob(root, /\.(yml|yaml)$/, ['node_modules', '.git', '.claude', '.next', 'dist'])) {
      this._scanFile(file, path.relative(root, file), result, 'yaml');
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
      const codeLine = maskNonCode(rawLine);

      for (const rule of RULES) {
        if (!rule.pattern.test(codeLine)) continue;
        if (rule.swallowGuard && isTolerantSwallow(rawLine)) continue;
        if (rule.code === 'set-e-disabled' && this._errexitHandled(lines, idx, mode)) continue;

        // `message` + rel path + line are what the finding registry, the
        // confidence scorer and the PR comment consume — this module used
        // to emit only `fix` with an absolute path, which surfaced as
        // `message: null` findings (2026-08-18 audit residue).
        result.addCheck(`bash-safety:${rule.code}:${rel}:${lineNum}`, false, {
          severity: rule.severity,
          file: rel,
          line: lineNum,
          message: rule.message(rawLine),
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
        if (rule.pattern.test(maskNonCode(cmd))) {
          if (rule.swallowGuard && isTolerantSwallow(cmd)) continue;
          result.addCheck(`bash-safety:${rule.code}:package.json:${name}`, false, {
            severity: rule.severity,
            file: 'package.json',
            message: `scripts.${name}: ${rule.message(cmd)}`,
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
      if (/\bset\s+-[a-zA-Z]*e/.test(maskNonCode(raw))) return true;
    }
    return false;
  }

  _isInRunBlock(lines, idx) {
    // Scan backwards to find if this line is under a "run:" key
    for (let i = idx; i >= Math.max(0, idx - 20); i--) {
      const l = lines[i].trim();
      if (/^-?\s*run:\s*/.test(l)) return true;
      if (/^\w/.test(l) && !l.startsWith('-') && i < idx) break;
    }
    return false;
  }

  _glob(root, pattern, excludes = []) {
    const results = [];
    // Segment-anchored exclusion. The previous `dir.includes('/.git')` also
    // matched `/.github`, so on Linux (every CI runner) no workflow file was
    // ever scanned — the module's whole CI-YAML surface was silently off.
    // On Windows the separators are backslashes and the substring never
    // matched, which is why the YAML tests passed locally and failed on CI.
    const excluded = new Set(excludes);
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (excluded.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (pattern.test(full.replace(/\\/g, '/'))) results.push(full);
      }
    };
    walk(root);
    return results;
  }
}

module.exports = BashSafetyModule;
