'use strict';

/**
 * One answer to "is this file a shell script?"
 *
 * KI #106 / the Fifty move 11. `shell` and `bashSafety` each picked their
 * files by extension, from two different private lists (`shell` knew
 * `.zsh`, `bashSafety` did not; neither knew `.ksh`). Extension is the
 * wrong question for the scripts that matter most: the deploy script in
 * `bin/`, the hook in `.githooks/`, the release helper in `scripts/` are
 * conventionally extensionless — `#!/usr/bin/env bash` on line one and
 * `chmod +x` — and both modules never opened one. A `rm -rf $DIR` in
 * `bin/deploy` was invisible; the same line in `bin/deploy.sh` blocked.
 *
 * The decision here is content-first: a shell extension, OR an
 * extensionless file whose first line is a shell shebang. Everything else
 * stays out — `LICENSE`, `Makefile`, `Dockerfile`, `Procfile` never carry a
 * shebang and are named here anyway so a stray `#!` in one cannot pull a
 * prose file into a security scan; a `#!/usr/bin/env node` or `ruby` or
 * `python` script is a script in another language and belongs to those
 * modules; a binary (`bin/splitsh-lite` in laravel is an ELF executable) is
 * recognised by a NUL byte in the sniffed head and skipped.
 *
 * The walk itself is not redefined: `collectShellScripts` goes through
 * `BaseModule._collectFiles(root, ['*'])`, so `--diff` / `--pr` scoping and
 * the shared exclude list (node_modules, vendor, dist, …) hold exactly as
 * they do for every other module (Doctrine §4).
 */

const fs = require('fs');
const path = require('path');
const { repoRelative } = require('./repo-path');

/** Extensions that are shell by declaration. */
const SHELL_EXTENSIONS = Object.freeze(['.sh', '.bash', '.zsh', '.ksh']);

/**
 * A shell shebang: `#!/bin/sh`, `#!/bin/bash -e`, `#! /bin/bash` (django's
 * `verify_release.sh` has the space), `#!/usr/bin/env bash`,
 * `#!/usr/bin/env -S bash -eu`, `#!/usr/local/bin/zsh`. Anchored on the
 * interpreter's basename so `#!/usr/bin/env node`, `ruby`, `python`,
 * `pwsh`, `fish` and Rust's `#![allow(...)]` inner attribute all stay out.
 */
const SHELL_SHEBANG_RE = /^#!\s*(?:\/[\w.\-/]*\/)?(?:env\s+(?:-S\s+)?)?(?:sh|bash|zsh|ksh|dash|ash|mksh)(?:\s|$)/;

/**
 * Extensionless names that are never scripts. Matched on the basename,
 * case-insensitively, with an optional `-suffix` / `.suffix` so `LICENSE-MIT`
 * and `Dockerfile` (extensionless) are covered while `Dockerfile.dev` (which
 * has an extension) never reaches this test anyway.
 */
const NON_SCRIPT_NAME_RE = /^(?:license|licence|copying|copyright|notice|authors|contributors|changelog|changes|history|readme|codeowners|makefile|gnumakefile|dockerfile|containerfile|procfile|vagrantfile|gemfile|rakefile|guardfile|podfile|brewfile|jenkinsfile|justfile|caddyfile|tiltfile)(?:[-_.].*)?$/i;

/** How much of an extensionless file is read to find the shebang. */
const SNIFF_BYTES = 256;

/** Read at most the first `SNIFF_BYTES` of a file; null when unreadable. */
function sniffHead(absPath) {
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(SNIFF_BYTES);
    const n = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* error-ok — closing after a failed read; nothing left to recover */ }
    }
  }
}

/** Is the first line of this head a shell shebang (and the head not binary)? */
function headIsShellScript(head) {
  if (!head || head.length < 3) return false;
  if (head[0] !== 0x23 || head[1] !== 0x21) return false;       // not `#!` — cheapest reject first
  if (head.includes(0)) return false;                            // NUL byte: binary, not a script
  const firstLine = head.toString('utf8').split(/\r?\n/, 1)[0];
  return SHELL_SHEBANG_RE.test(firstLine);
}

/**
 * Shell by extension, or extensionless with a shell shebang. `relPath` is
 * used for the name tests; `absPath` is what gets opened when a sniff is
 * needed. Only extensionless files are ever read.
 */
function isShellScript(absPath, relPath = absPath) {
  const base = path.basename(relPath);
  const ext = path.extname(base).toLowerCase();
  if (SHELL_EXTENSIONS.includes(ext)) return true;
  if (ext !== '') return false;
  if (NON_SCRIPT_NAME_RE.test(base)) return false;
  return headIsShellScript(sniffHead(absPath));
}

/**
 * Every shell script the module is allowed to see, through the module's own
 * shared walk. `alsoExts` lets a module that also reads other files (bash-
 * safety's CI YAML) get them from the SAME walk instead of a second one.
 *
 * @returns {{ scripts: string[], others: string[] }} absolute paths
 */
function collectShellScripts(module, projectRoot, alsoExts = []) {
  const also = alsoExts.map((e) => e.toLowerCase());
  const scripts = [];
  const others = [];
  for (const file of module._collectFiles(projectRoot, ['*'])) {
    const rel = repoRelative(projectRoot, file);
    if (isShellScript(file, rel)) scripts.push(file);
    else if (also.length && also.includes(path.extname(file).toLowerCase())) others.push(file);
  }
  return { scripts, others };
}

/**
 * A build tool's own wrapper script, checked in verbatim by `gradle wrapper`
 * / `mvn wrapper:wrapper` and regenerated the same way — not code the
 * project's authors wrote or would edit by hand. Findings in it are reported
 * (a reader should know the `eval "set -- $(…)"` is there) but cannot block a
 * build the project cannot change: spring-petclinic and ktor each carry the
 * stock gradlew, and its line 241 became a blocking `shell:eval-var` the day
 * the confidence scorer stopped mis-masking shell as JavaScript (2026-09-05).
 */
const VENDORED_WRAPPER_RE = /^(?:gradlew|gradlew\.bat|mvnw|mvnw\.cmd)$/;
function isVendoredWrapper(relPath) {
  return VENDORED_WRAPPER_RE.test(path.basename(String(relPath)));
}

module.exports = {
  SHELL_EXTENSIONS,
  isVendoredWrapper,
  SHELL_SHEBANG_RE,
  NON_SCRIPT_NAME_RE,
  SNIFF_BYTES,
  headIsShellScript,
  isShellScript,
  collectShellScripts,
};
