/**
 * Shell Script Module — hardening scanner for Bash / POSIX shell.
 *
 * Shell scripts are the soft underbelly of every repo: they run with full
 * developer/CI privileges, are almost never unit-tested, and a single
 * unquoted variable can become `rm -rf /`. This module scans every shell
 * script — `.sh` / `.bash` / `.zsh` / `.ksh` by extension, plus every
 * extensionless file with a shell shebang (`bin/deploy`, `.githooks/pre-push`,
 * `scripts/release` — decided once in `src/core/shell-files.js`, KI #106) —
 * and flags the highest-impact classes of mistake:
 *
 *   - curl | sh / wget | bash          → remote-exec (supply-chain)
 *   - `rm -rf $VAR`                    → empty-var root-wipe
 *   - `eval` of variables / $(cmd)     → dynamic code injection
 *   - Hard-coded AWS key / private key / bearer token
 *   - Missing `set -e` / `set -euo pipefail` (silent failure)
 *   - `#!/bin/sh` but uses bashisms (`[[`, `<<<`, arrays) → portability lie
 *   - Backtick command substitution                      → use `$(...)`
 *   - Missing shebang on a `.sh` file                    → non-executable
 *
 * Zero dependencies. Line-heuristic only (no AST, no shellcheck). Results
 * are pattern-keyed (`shell:unsafe-rm:<rel>:<line>`) so the memory module
 * can cluster fixes across scans.
 *
 * TODO(gluecron): once Gluecron ships a runner-config API we can also lint
 * the `script:` blocks inside Gluecron pipeline YAML the same way.
 */

const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const BaseModule = require('./base-module');
const { collectShellScripts, isVendoredWrapper } = require('../core/shell-files');

// Hard-coded credentials baked into scripts — same catalogue as secrets
// module but trimmed to the patterns that show up in CI/ops scripts most.
const SECRET_PATTERNS = [
  { name: 'aws-key',       pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'private-key',   pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'generic-token', pattern: /(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*["']?[A-Za-z0-9+/_-]{16,}["']?/i },
  { name: 'bearer',        pattern: /Bearer\s+[A-Za-z0-9\-_=]{20,}/ },
];

// Bashisms that `#!/bin/sh` must never use.
const BASHISMS = [
  { name: 'double-bracket', pattern: /\[\[\s/ },
  { name: 'here-string',    pattern: /<<</ },
  { name: 'array-decl',     pattern: /\b(?:declare|local|readonly)\s+-[aA]\b/ },
  { name: 'array-expand',   pattern: /\$\{\s*[A-Za-z_][A-Za-z0-9_]*\[@\]/ },
  { name: 'process-sub',    pattern: /<\(/ },
];

class ShellModule extends BaseModule {
  constructor() {
    super('shell', 'Shell Script Security — curl|sh, unsafe rm, eval injection, hardcoded secrets, set -e, POSIX compliance');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    // Shared walk + shared "is this a shell script" (KI #104 / #106) —
    // honours --diff/--pr scoping and finds extensionless shebang scripts.
    const { scripts } = collectShellScripts(this, projectRoot);

    if (scripts.length === 0) {
      result.addCheck('shell:no-files', true, {
        severity: 'info',
        message: 'No shell scripts found — skipping',
      });
      return;
    }

    result.addCheck('shell:scanning', true, {
      severity: 'info',
      message: `Scanning ${scripts.length} shell script(s)`,
    });

    let totalIssues = 0;
    for (const file of scripts) {
      totalIssues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('shell:summary', true, {
      severity: 'info',
      message: `Shell scan: ${scripts.length} file(s), ${totalIssues} issue(s)`,
    });
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      return 0;
    }

    const rel = repoRelative(projectRoot, file);
    const lines = content.split(/\r?\n/);
    let issues = 0;
    // A vendored build-tool wrapper (src/core/shell-files.js isVendoredWrapper)
    // is reported at info: the finding is real, the file is not the project's
    // to edit, and blocking on it would block every Gradle and Maven project.
    const vendored = isVendoredWrapper(rel);
    const flag = (name, details) => this._flag(result, name, vendored
      ? { ...details, severity: 'info', message: `${details.message} — in a vendored build-tool wrapper (${path.basename(rel)}); regenerate it with the tool rather than editing it, and read the finding as information` }
      : details);

    const firstNonBlank = lines.find((l) => l.trim().length > 0) || '';
    const hasShebang = firstNonBlank.startsWith('#!');
    const shebangIsSh = /^#!\s*\/(?:usr\/)?bin\/sh\b/.test(firstNonBlank);

    if (!hasShebang) {
      issues += this._flag(result, `shell:no-shebang:${rel}`, {
        severity: 'info',
        file: rel,
        line: 1,
        message: `${rel} has no shebang — will run under the caller's default shell (non-portable)`,
        suggestion: 'Add `#!/usr/bin/env bash` (or `#!/bin/sh` for strict POSIX) as the first line.',
      });
    }

    // Top-of-file `set -e` / `set -euo pipefail`. Allow first 10 non-blank
    // non-comment lines to contain it (some scripts do sourcing first).
    let hasSetE = false;
    let scanned = 0;
    for (const raw of lines) {
      const t = raw.trim();
      if (!t || t.startsWith('#')) continue;
      if (/^set\s+-[euo\w]*e/.test(t) || /^set\s+-o\s+errexit/.test(t)) {
        hasSetE = true;
        break;
      }
      scanned += 1;
      if (scanned >= 10) break;
    }
    if (hasShebang && !hasSetE) {
      issues += this._flag(result, `shell:missing-set-e:${rel}`, {
        severity: 'warning',
        file: rel,
        message: `${rel} does not set \`-e\` — failed commands silently continue`,
        suggestion: 'Add `set -euo pipefail` near the top so the script aborts on errors, undefined vars, and pipe failures.',
      });
    }

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const line = raw.replace(/\s+$/, '');
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // 1. curl | sh / wget | bash
      if (/\b(?:curl|wget)\b[^|]*\|\s*(?:sh|bash|zsh)\b/.test(trimmed)) {
        issues += flag(`shell:curl-pipe-sh:${rel}:${i + 1}`, {
          severity: 'error',
          file: rel,
          line: i + 1,
          message: 'Remote script piped to shell — no integrity check, arbitrary code execution',
          suggestion: 'Download the script to a file, pin a SHA-256, verify, then execute.',
        });
      }

      // 2. rm -rf with unquoted variable / path expansion.
      //
      // RECURSIVE is the whole hazard. The flag cluster must carry `r` / `R`
      // (or `--recursive`): an empty `$VAR` turns `rm -rf $VAR` into
      // `rm -rf` of the current tree (or, with a trailing `/`, of `/`), but
      // `rm -f $VAR` with an empty variable is `rm -f` — "missing operand",
      // a no-op that `-f` even silences. The old `-[rRfF]+` accepted a bare
      // `-f`, and the message then reported it as `rm -rf`: django's
      // `scripts/backport.sh:33` (`rm -f ${TMPFILE}` after `mktemp`) was a
      // gate-blocking "wipes the filesystem root" (2026-09-14). Flags are
      // matched as a run of clusters so `rm -r -f $X` and `rm -f -r $X` both
      // read the same, and the target is the first non-flag word.
      const rmMatch = trimmed.match(/\brm\s+((?:--?[a-zA-Z-]+\s+)+)([^\s#;&|-][^\s#;&|]*)/);
      const rmRecursive = rmMatch && /(?:^|\s)-[a-zA-Z]*[rR]|(?:^|\s)--recursive\b/.test(rmMatch[1]);
      if (rmRecursive) {
        const target = rmMatch[2];
        // Bare `$VAR` or `${VAR}` without quotes, or literal `/` / `/*`.
        const unquotedVar = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(target);
        const rootish = /^\/(?:\*)?$/.test(target) || /^\/[^/]+\/\*?$/.test(target) && target.split('/').length <= 3;
        if (unquotedVar || rootish) {
          issues += flag(`shell:unsafe-rm:${rel}:${i + 1}`, {
            severity: 'error',
            file: rel,
            line: i + 1,
            message: `\`rm -rf ${target}\` — if the variable is empty/unset this wipes the filesystem root`,
            suggestion: 'Quote the variable and guard against empty: `: "${VAR:?VAR is required}" && rm -rf -- "$VAR"`',
          });
        }
      }

      // 3. eval of variables or command substitution
      //
      // issue #633 (2026-09-22): `run(){ eval "$@"; }` — the standard
      // dry-run/verbose-command wrapper idiom (`run "$@"` logs then
      // `eval`s the caller's own already-tokenized positional
      // parameters) — was reported 5x on one repo, 0 of them real. `"$@"`
      // is structurally different from `eval "$VAR"` or `eval "$(cmd)"`:
      // the shell has already split it into the caller's own argument
      // vector, not a single string an attacker can smuggle metacharacters
      // through by controlling ONE variable's contents. Scoped narrowly to
      // eval's entire argument being `$@`/`"$@"`/`${@}`/`"$*"` and nothing
      // else — `eval "$@ extra"` or `eval "$1"` still fire below.
      const evalArgsPassthrough = /\beval\s+["']?\$\{?[@*]\}?["']?\s*;?\s*\}?\s*$/.test(trimmed);
      if (!evalArgsPassthrough && (/\beval\s+["']?\$/.test(trimmed) || /\beval\s+.*\$\(/.test(trimmed) || /\beval\s+.*`/.test(trimmed))) {
        issues += flag(`shell:eval-var:${rel}:${i + 1}`, {
          severity: 'error',
          file: rel,
          line: i + 1,
          message: '`eval` of a variable or command substitution — arbitrary code execution risk',
          suggestion: 'Replace `eval` with an explicit command. If dynamic dispatch is genuinely needed, use an allow-list case statement.',
        });
      }

      // 4. Hard-coded secrets
      for (const { name, pattern } of SECRET_PATTERNS) {
        if (pattern.test(line)) {
          issues += flag(`shell:hardcoded-secret:${name}:${rel}:${i + 1}`, {
            severity: 'error',
            file: rel,
            line: i + 1,
            message: `Hard-coded ${name} in shell script — credentials leak on every checkout and in shell history`,
            suggestion: 'Read secrets from env vars (`"${MY_TOKEN:?}"`), or use a secret manager. Rotate any leaked value immediately.',
          });
        }
      }

      // 5. #!/bin/sh but uses bashisms
      if (shebangIsSh) {
        for (const { name, pattern } of BASHISMS) {
          if (pattern.test(line)) {
            issues += flag(`shell:sh-but-bashism:${name}:${rel}:${i + 1}`, {
              severity: 'warning',
              file: rel,
              line: i + 1,
              message: `Shebang claims POSIX \`/bin/sh\` but uses bashism (${name}) — fails on dash/ash`,
              suggestion: 'Either switch the shebang to `#!/usr/bin/env bash` or rewrite to POSIX-portable syntax.',
            });
            break;
          }
        }
      }

      // 6. Backtick command substitution
      if (/`[^`]+`/.test(line) && !/^#/.test(trimmed)) {
        issues += flag(`shell:backticks:${rel}:${i + 1}`, {
          severity: 'info',
          file: rel,
          line: i + 1,
          message: 'Backtick command substitution — $(...) is safer (nests without escaping) and clearer',
          suggestion: 'Replace `` `cmd` `` with `$(cmd)`.',
        });
      }
    }

    return issues;
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = ShellModule;
