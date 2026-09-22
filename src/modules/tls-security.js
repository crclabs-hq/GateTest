/**
 * TLS / Certificate-Validation-Bypass Detector Module.
 *
 * "Just disable SSL for dev" is how MITM-vulnerable apps ship to prod.
 * The canonical pattern: a developer hits a self-signed cert on staging,
 * disables validation once, and the flag never gets flipped back. The
 * code now trusts ANY cert — including one issued by an attacker on the
 * network path. Every pentest finds it. Every compliance audit flags it.
 *
 * We catch the loudest, most well-known disable patterns across JS and
 * Python — the ones that cannot be explained away as dev-only because
 * they ship in the same file that calls prod APIs:
 *
 *   JS/TS:
 *     - `rejectUnauthorized: false` — Node https.Agent / tls options
 *     - `NODE_TLS_REJECT_UNAUTHORIZED = "0"` — global nuclear disable
 *     - `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` — same
 *     - `strictSSL: false` — `request` lib
 *     - `insecure: true` — some HTTP clients
 *
 *   Python:
 *     - `requests.get/post/...(..., verify=False, ...)` — the classic
 *     - `httpx.Client(verify=False)` / `httpx.get(url, verify=False)`
 *     - `aiohttp.TCPConnector(verify_ssl=False)` / `ssl=False`
 *     - `ssl._create_unverified_context()` — deliberate bypass
 *     - `ctx.check_hostname = False` — hostname-validation disable
 *     - `ctx.verify_mode = ssl.CERT_NONE` — cert-validation disable
 *     - `cert_reqs='CERT_NONE'` — urllib3 PoolManager / HTTPSConnectionPool
 *     - `urllib3.disable_warnings(InsecureRequestWarning)` — the
 *       tell-tale pairing with `verify=False`
 *
 * Rules:
 *
 *   error:   JS `rejectUnauthorized: false`
 *            (rule: `tls-security:js-reject-unauthorized:<rel>:<line>`)
 *
 *   error:   JS `NODE_TLS_REJECT_UNAUTHORIZED = "0"` (any form)
 *            (rule: `tls-security:js-env-bypass:<rel>:<line>`)
 *
 *   error:   JS `strictSSL: false` (request / superagent / got family)
 *            (rule: `tls-security:js-strict-ssl:<rel>:<line>`)
 *
 *   error:   Python `verify=False` or `verify_ssl=False` or `ssl=False`
 *            as a keyword argument.
 *            (rule: `tls-security:py-verify-false:<rel>:<line>`)
 *
 *   error:   Python `ssl._create_unverified_context()`.
 *            (rule: `tls-security:py-unverified-context:<rel>:<line>`)
 *
 *   error:   Python `.check_hostname = False`.
 *            (rule: `tls-security:py-check-hostname-false:<rel>:<line>`)
 *
 *   error:   Python `ssl.CERT_NONE` / `cert_reqs='CERT_NONE'` usage.
 *            (rule: `tls-security:py-cert-none:<rel>:<line>`)
 *
 *   warning: Python `urllib3.disable_warnings(InsecureRequestWarning)`.
 *            (rule: `tls-security:py-disable-warnings:<rel>:<line>`)
 *
 * Suppressions:
 *   - `// tls-ok` / `# tls-ok` on same or preceding line.
 *   - Test / spec / fixture / benchmark paths downgrade error → warning,
 *     warning → info. The predicate is the shared `_isTestPath`
 *     (src/core/test-paths.js); a benchmark that points a client at its
 *     own local server with `rejectUnauthorized: false` is a harness, not
 *     a deployment — got's `benchmark/index.ts` was gate-BLOCKED on four
 *     such lines at confidence 1.0 (2026-09-14). `examples/` is NOT a
 *     harness (tRPC keeps real workspaces there); a bypass in one blocks.
 *
 * Competitors:
 *   - ESLint has nothing cross-cutting. SonarQube has "TLS cert
 *     validation disabled" (`javascript:S4830`) but JS only and
 *     narrow — misses `strictSSL: false`.
 *   - Bandit catches Python `verify=False` for `requests` specifically
 *     but misses httpx / aiohttp / urllib3 PoolManager patterns.
 *   - Snyk Code catches subsets behind its SaaS — no unified gate.
 *   - Nothing unifies Node `rejectUnauthorized` + env bypass + Python
 *     `verify=False` + `_create_unverified_context` + CERT_NONE
 *     across a single static check with suppressions and test-path
 *     downgrade.
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


const SUPPRESS_RE = /\btls-ok\b/;

// JS/TS patterns — every one is matched on the MASKED line
// (BaseModule._maskedLines): string, template, regex and comment bodies are
// blanked there, so `rejectUnauthorized: false` in a docstring, in a fixture
// string, or in a test's `assert.doesNotMatch(out, /rejectUnauthorized: false/)`
// cannot fire (self-scan 2026-07-15), and neither can one in a block comment
// or template literal that started on an earlier line (2026-09-05).
const JS_REJECT_UNAUTHORIZED_RE = /\brejectUnauthorized\s*:\s*false\b/;
// Require `process.env.` / `process.env[...]` prefix so the rule only
// fires on an actual Node env write, not on prose / error-message text
// that references the variable name. The bracket key and the `"0"` are
// string bodies — blanked on the masked line — so the SHAPE is matched
// there and the full pattern is then confirmed on the raw line at the same
// offset (the mask preserves offsets; sticky regex).
const JS_NODE_TLS_ENV_SHAPE_RE =
  /process\.env\s*(?:\.\s*NODE_TLS_REJECT_UNAUTHORIZED|\[\s*['"] *['"]\s*\])\s*=/;
const JS_NODE_TLS_ENV_RE =
  /process\.env\s*(?:\.\s*NODE_TLS_REJECT_UNAUTHORIZED|\[\s*['"]NODE_TLS_REJECT_UNAUTHORIZED['"]\s*\])\s*=\s*['"]?0['"]?/y;
const JS_STRICT_SSL_RE = /\bstrictSSL\s*:\s*false\b/;
const JS_INSECURE_RE = /\binsecure\s*:\s*true\b/;

const JS_ENV_BYPASS_RULE = {
  id: 'js-env-bypass',
  message: '`NODE_TLS_REJECT_UNAUTHORIZED = "0"` globally disables TLS validation for the entire Node process. Every outbound HTTPS call becomes vulnerable to MITM.',
};
const JS_RULES = [
  { re: JS_REJECT_UNAUTHORIZED_RE, id: 'js-reject-unauthorized', message: '`rejectUnauthorized: false` disables TLS cert validation — every cert, including attacker-issued ones, is trusted. MITM risk.' },
  { re: JS_STRICT_SSL_RE, id: 'js-strict-ssl', message: '`strictSSL: false` disables TLS cert validation in the `request` / `superagent` / `got` family.' },
  { re: JS_INSECURE_RE, id: 'js-insecure-flag', message: '`insecure: true` disables TLS validation in several HTTP-client configurations.' },
];

// issue #657 (Tallrig, apps/api/src/domains/tls-probe.ts:287): a raw TLS
// handshake PROBE — `tls.connect({ …, rejectUnauthorized: false })` inside
// a helper like `observeHandshake()` — must be able to complete the
// handshake against a broken / self-signed peer certificate in order to
// GRADE it (the verdict is read back from `socket.authorized` /
// `getPeerCertificate()` / `authorizationError`). `tls.connect` itself
// never sends a request over that socket — it hands back a `TLSSocket`;
// the deliberate laxity is the point of a probe, not a weakened client.
// That is a different shape from `https.request({ rejectUnauthorized:
// false })` or an axios/got/superagent config, which stay firing
// unconditionally — a real client trusting any cert is exactly what this
// rule exists to catch, so the exemption requires BOTH:
//   1. the enclosing call the property sits in is `(tls.)?connect(` —
//      never an HTTP request/response call, and
//   2. the SAME FILE inspects the handshake result it just relaxed
//      (`socket.authorized`, `.getPeerCertificate(`, `authorizationError`)
//      — the tell that this code grades the peer certificate instead of
//      silently trusting it.
// Both conditions are checked on the MASKED text (comments/strings blanked)
// so a docstring mentioning "socket.authorized" cannot manufacture the
// exemption.
const TLS_CONNECT_CALLEE_RE = /(?:^|\.)connect$/;
const TLS_PROBE_INSPECTION_RE = /\bsocket\s*\.\s*authorized\b|\.\s*getPeerCertificate\s*\(|\bauthorizationError\b/;

/**
 * Walk backward from `(lineIdx, col)` through `maskedLines`, tracking paren
 * depth, to find the callee of the nearest enclosing, not-yet-closed call —
 * the multi-line twin of hardcoded-url.js's `_enclosingCallee` (an options
 * object almost always spans several lines: `tls.connect({\n  host: …,\n
 * rejectUnauthorized: false,\n})`, so a single-line lookback never reaches
 * the `tls.connect(` that opened it).
 */
function _enclosingCallName(maskedLines, lineIdx, col) {
  let depth = 0;
  for (let line = lineIdx; line >= 0; line -= 1) {
    const text = line === lineIdx ? (maskedLines[line] || '').slice(0, col) : (maskedLines[line] || '');
    for (let p = text.length - 1; p >= 0; p -= 1) {
      const ch = text[p];
      if (ch === ')') { depth += 1; continue; }
      if (ch === '(') {
        if (depth === 0) {
          const head = text.slice(0, p);
          const m = head.match(/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*$/);
          return m ? m[1].replace(/\s+/g, '') : null;
        }
        depth -= 1;
      }
    }
  }
  return null;
}

// Python patterns.
// `verify=False`, `verify_ssl=False`, `ssl=False` — but NOT `ssl=False`
// inside a function definition or type annotation. We require it to be
// preceded by a comma or `(` (i.e. actually an argument).
const PY_VERIFY_FALSE_RE = /[,(]\s*(verify|verify_ssl|ssl)\s*=\s*False\b/;
const PY_UNVERIFIED_CTX_RE = /\bssl\._create_unverified_context\s*\(/;
const PY_CHECK_HOSTNAME_FALSE_RE = /\.check_hostname\s*=\s*False\b/;
const PY_CERT_NONE_RE = /\bssl\.CERT_NONE\b|cert_reqs\s*=\s*['"]CERT_NONE['"]/;
const PY_DISABLE_WARNINGS_RE =
  /\burllib3\.disable_warnings\s*\([^)]*InsecureRequestWarning/;

class TlsSecurityModule extends BaseModule {
  constructor() {
    super(
      'tlsSecurity',
      'TLS / cert-validation-bypass detector — catches rejectUnauthorized:false, verify=False, ssl.CERT_NONE, and NODE_TLS_REJECT_UNAUTHORIZED=0'
    );
  }

  async run(result, config) {
    if (config && config.livePage) {
      // A fetch's headers/HTML never carry the negotiated TLS protocol or
      // the peer certificate — that needs its own raw socket connection,
      // which the single shared `config.livePage` fetch deliberately does
      // not make (Doctrine §1: no fabricated pass; honestly not-checked).
      this._notChecked(result, 'this module reads source code for TLS-validation bypass patterns (rejectUnauthorized:false, verify=False, …) — inspecting a live certificate/protocol needs a raw socket connection, which the shared page fetch for this scan does not make');
      return;
    }

    if (this._isUrlOnlyScan(config)) {
      this._notChecked(result, 'this module reads source files (TLS-validation-bypass patterns), not a live URL — no project files were provided for this scan');
      return;
    }

    const projectRoot = config.projectRoot;
    const files = this._collect(projectRoot);

    if (files.length === 0) {
      result.addCheck('tls-security:no-files', true, {
        severity: 'info',
        message: 'No source files to scan',
      });
      return;
    }

    result.addCheck('tls-security:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} file(s)`,
      fileCount: files.length,
    });

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
        issues += this._scanPy(rel, text, result);
      }
    }

    result.addCheck('tls-security:summary', true, {
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
    const errSev = isTest ? 'warning' : 'error';
    const lines = text.split(/\r?\n/);
    const masked = this._maskedLines(text);
    // Whole-file signal 2 of the tls-probe exemption (issue #657): computed
    // once per file, not per match — "inspected … in the same function or
    // file" is satisfied at file scope.
    const fileInspectsHandshake = masked.some((l) => TLS_PROBE_INSPECTION_RE.test(l || ''));
    let issues = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];        // raw: the `"0"` value, `tls-ok` markers
      const code = masked[i] || ''; // masked: every pattern match
      if (this._suppressed(lines, i)) continue;

      const fired = [];
      if (this._matchOnRaw(code, line, JS_NODE_TLS_ENV_SHAPE_RE, JS_NODE_TLS_ENV_RE)) fired.push(JS_ENV_BYPASS_RULE);
      for (const rule of JS_RULES) {
        const m = rule.re.exec(code);
        if (!m) continue;
        if (rule.id === 'js-reject-unauthorized' && fileInspectsHandshake) {
          const callee = _enclosingCallName(masked, i, m.index);
          if (callee && TLS_CONNECT_CALLEE_RE.test(callee)) continue; // a graded probe, not a weakened client
        }
        fired.push(rule);
      }
      for (const rule of fired) {
        result.addCheck(`tls-security:${rule.id}:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: rule.message,
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }
    }
    return issues;
  }

  _scanPy(rel, text, result) {
    const isTest = this._isTestPath(rel);
    const errSev = isTest ? 'warning' : 'error';
    const warnSev = isTest ? 'info' : 'warning';
    const lines = text.split(/\r?\n/);
    let issues = 0;
    let inDocstring = false;
    let docQuote = null;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      if (inDocstring) {
        if (line.includes(docQuote)) {
          inDocstring = false;
          docQuote = null;
        }
        continue;
      }
      const md = line.match(/^\s*(["']{3})/);
      if (md) {
        const rest = line.slice(line.indexOf(md[1]) + 3);
        if (!rest.includes(md[1])) {
          inDocstring = true;
          docQuote = md[1];
          continue;
        }
      }

      let codeLine = line;
      const hashIdx = this._findUnquotedHash(codeLine);
      if (hashIdx !== -1) codeLine = codeLine.slice(0, hashIdx);

      if (this._suppressed(lines, i)) continue;

      if (PY_VERIFY_FALSE_RE.test(codeLine)) {
        result.addCheck(`tls-security:py-verify-false:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: '`verify=False` / `verify_ssl=False` / `ssl=False` disables TLS cert validation in requests / httpx / aiohttp. MITM risk.',
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }
      if (PY_UNVERIFIED_CTX_RE.test(codeLine)) {
        result.addCheck(`tls-security:py-unverified-context:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: '`ssl._create_unverified_context()` returns a context that trusts any cert.',
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }
      if (PY_CHECK_HOSTNAME_FALSE_RE.test(codeLine)) {
        result.addCheck(`tls-security:py-check-hostname-false:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: '`.check_hostname = False` disables hostname validation. An attacker\'s valid cert for a different domain will pass.',
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }
      if (PY_CERT_NONE_RE.test(codeLine)) {
        result.addCheck(`tls-security:py-cert-none:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: '`ssl.CERT_NONE` / `cert_reqs=\'CERT_NONE\'` disables cert validation — any cert (or no cert) is accepted.',
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }
      if (PY_DISABLE_WARNINGS_RE.test(codeLine)) {
        result.addCheck(`tls-security:py-disable-warnings:${rel}:${i + 1}`, false, {
          severity: warnSev,
          message: '`urllib3.disable_warnings(InsecureRequestWarning)` silences the warning that TLS validation is off. Usually paired with `verify=False`.',
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
}

module.exports = TlsSecurityModule;
