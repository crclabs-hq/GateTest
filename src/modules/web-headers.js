/**
 * Web Headers Module — security-header misconfiguration + CORS abuse.
 *
 * Every production web app is one missing header away from a real
 * bug bounty payout. CSP absent? XSS lands every time. HSTS absent?
 * MITM on first-visit wifi. `Access-Control-Allow-Origin: *` combined
 * with `Access-Control-Allow-Credentials: true`? Cross-site credential
 * theft. This module reads the config files where headers actually
 * get set — not just runtime responses — so it works offline against
 * the repo itself.
 *
 * Scanned configs (discovery):
 *
 *   - next.config.{js,mjs,ts} — Next.js `async headers()` block
 *   - vercel.json / vercel.toml — `headers` array
 *   - netlify.toml / _headers — Netlify header config
 *   - Express/Fastify/Koa source — `app.use(helmet())`, manual
 *     `res.setHeader` / `res.header` / `reply.header` calls
 *   - nginx.conf / *.nginx — `add_header` directives
 *   - Cloudfront / ALB / API Gateway snippets are out of scope for
 *     this scan (that's `gatetest --module terraform` or cloud-native
 *     tooling).
 *
 * Rules:
 *
 *   error:   CORS `Access-Control-Allow-Origin: *` co-occurs with
 *            `Access-Control-Allow-Credentials: true` — spec says
 *            browsers reject this, but several frameworks ship it
 *            anyway and old clients / server-to-server usage don't
 *            enforce the rejection.
 *            (rule: `web-headers:cors-wildcard-with-credentials:<rel>:<line>`)
 *   error:   CSP contains `unsafe-eval` — re-enables `eval()`-class
 *            attacks in the browser.
 *            (rule: `web-headers:csp-unsafe-eval:<rel>:<line>`)
 *   warning: CSP contains `unsafe-inline` — re-enables inline-script XSS.
 *            (rule: `web-headers:csp-unsafe-inline:<rel>:<line>`)
 *   warning: Header config exists but no `Content-Security-Policy`
 *            header is set. (per-config file)
 *            (rule: `web-headers:missing-csp:<rel>`)
 *   warning: Header config exists but no `Strict-Transport-Security`
 *            (rule: `web-headers:missing-hsts:<rel>`)
 *   warning: Header config exists but no `X-Frame-Options` and no CSP
 *            `frame-ancestors` — clickjacking surface.
 *            (rule: `web-headers:missing-frame-options:<rel>`)
 *   warning: HSTS max-age < 15552000 (180 days) — below Mozilla guidance.
 *            (rule: `web-headers:hsts-short:<rel>:<line>`)
 *   info:    No `X-Content-Type-Options: nosniff` — MIME-sniff
 *            vectors still exist in some browsers.
 *            (rule: `web-headers:missing-nosniff:<rel>`)
 *
 * Because this scan is line-heuristic, it targets config files and
 * clear header-setting call-sites. We don't try to evaluate runtime
 * middleware chains — that's what a black-box DAST would do.
 *
 * TODO(gluecron): when Gluecron ships deploy-config YAML, mirror
 * these rules to whatever header surface it lands on.
 */

const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const BaseModule = require('./base-module');
const { CSP_UNSAFE_EVAL_TOKEN } = require('../core/reliability/url-prober');
// One definition of directive-aware `unsafe-inline` classification (issue
// #681 item 3), shared with src/scanners/server-scanner.js.
const { classifyUnsafeInline } = require('../core/csp-analyzer');

// A line whose first non-whitespace characters are a comment marker. Used
// to skip lines like `// NO 'unsafe-eval'` before the CSP token check runs
// — the marker text mentions the directive without setting it. Deliberately
// a prefix check, not a full tokenizer: `maskCommentsAndStrings` in
// `typescript-strictness.js` also masks string CONTENTS, which would erase
// the very CSP token (itself a quoted string) this module searches for.
const COMMENT_LINE_PREFIXES = ['//', '#', '/*', '*', '--'];
function _isCommentLine(trimmed) {
  return COMMENT_LINE_PREFIXES.some((marker) => trimmed.startsWith(marker));
}

// Directory excludes beyond what `BaseModule._collectFiles` already skips
// (node_modules, .git, dist, build, coverage, .next, out, …). The old
// private walk (removed under KI #104) also skipped these.
const EXTRA_EXCLUDES = ['.terraform'];

// Anything whose content we'll scan for header config. We match by
// filename / path, not by content, because the callsite matters.
const CONFIG_NAMES = [
  'next.config.js', 'next.config.mjs', 'next.config.ts',
  'vercel.json', 'netlify.toml', '_headers',
  'nginx.conf',
];

// Config files that CAN set headers but usually do something else too
// (`.htaccess` is mostly rewrites, a Caddyfile mostly routes). They are
// header config only when they carry a header directive — otherwise the
// missing-CSP/HSTS warnings would fire on every rewrite-only `.htaccess`.
const DIRECTIVE_CONFIG_NAMES = ['.htaccess', 'Caddyfile', 'httpd.conf', 'apache2.conf', 'haproxy.cfg'];
const HEADER_DIRECTIVE_RE = /^\s*(?:Header\s+(?:always\s+|onsuccess\s+)?(?:set|add|append|merge|edit)\b|header\s+[+-]?[A-Za-z-]|add_header\b|http-response\s+(?:set|add)-header\b)/im;

const CONFIG_EXTENSIONS = ['.nginx'];

// Server source in every language the engine scans. The rules below key on
// HEADER NAMES (`content-security-policy`, `access-control-allow-origin`,
// …), which look the same in Express, Koa, Flask, Gin, Rails and PHP — so
// the file gate asks whether the file mentions one, not whether it is
// JavaScript. Until 2026-09-05 only .js/.ts files were ever opened and only
// when they used `setHeader`/`res.header`/`helmet`: a Koa `ctx.set(...)`,
// a `res.writeHead(200, {...})`, or a Flask `response.headers[...] = '*'`
// with credentials could report `web-headers:no-files` clean (KI #106).
const SERVER_SOURCE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.go', '.rb', '.php', '.java', '.kt', '.rs', '.cs', '.scala', '.ex', '.exs',
  '.conf',
]);

// Only files that mention something a rule can fire on are opened for
// scanning. A header name (any language), a header-setting API, or a
// framework that sets them for you.
const HEADER_HINTS = /content-security-policy|strict-transport-security|x-frame-options|frame-ancestors|x-content-type-options|access-control-allow-(?:origin|credentials)|\bhelmet\b|\bsetHeader\b|reply\.header|res\.header|\bctx\.set\b|\bwriteHead\s*\(|headers\s*:/i;

// Content is sniffed, so cap what we are willing to read for the hint.
const MAX_SNIFF_BYTES = 1024 * 1024;

const HSTS_MIN_MAX_AGE = 15552000; // 180 days, aligns with Mozilla

/** Read a header by lowercase name from either a WHATWG `Headers`-like
 *  object (`.get(name)`) or a plain `{ [name]: value }` object — the two
 *  shapes a caller can reasonably hand us for one already-fetched response. */
function _headerGet(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name) || null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : null;
}

/**
 * The live-response equivalent of this module's static-file rules: same
 * signals (CSP present/unsafe-eval/unsafe-inline, HSTS present/max-age,
 * X-Frame-Options or frame-ancestors, X-Content-Type-Options, CORS
 * wildcard+credentials), read from actual response headers instead of
 * source config. Exported so `/api/scan/url` and the hosted web scan can
 * both call it — one definition (Doctrine §4) — rather than keeping two
 * header-rule lists that drift.
 *
 * @param {unknown} headers — WHATWG Headers-like or plain object
 * @returns {Array<{id:string, severity:'error'|'warning'|'info', message:string, suggestion:string}>}
 */
function liveHeaderChecks(headers) {
  const findings = [];
  const csp = _headerGet(headers, 'content-security-policy');
  const hsts = _headerGet(headers, 'strict-transport-security');
  const xfo = _headerGet(headers, 'x-frame-options');
  const nosniff = _headerGet(headers, 'x-content-type-options');
  const acao = _headerGet(headers, 'access-control-allow-origin');
  const acac = _headerGet(headers, 'access-control-allow-credentials');

  if (!csp) {
    findings.push({
      id: 'live-missing-csp', severity: 'warning',
      message: 'No Content-Security-Policy header on the live response — XSS payloads run with the full permissions of the origin',
      suggestion: "Add a strict CSP starting from default-src 'self'; script-src 'self' and open only what you need.",
    });
  } else {
    if (CSP_UNSAFE_EVAL_TOKEN.test(csp)) {
      findings.push({
        id: 'live-csp-unsafe-eval', severity: 'error',
        message: 'Content-Security-Policy contains `unsafe-eval` — re-enables eval()/new Function() class attacks',
        suggestion: 'Refactor away from eval, or use a strict-dynamic + nonce CSP instead.',
      });
    }
    // Directive-aware (issue #681 item 3): 'unsafe-inline' in script-src (or
    // default-src when script-src is absent) can execute injected script —
    // stays a warning. 'unsafe-inline' ONLY in style-src cannot execute
    // script, so a site that deliberately keeps it there for inline style
    // assets (while locking script-src down with a nonce) gets an info
    // note naming the directive instead of the same warning.
    const unsafeInline = classifyUnsafeInline(csp);
    if (unsafeInline && unsafeInline.severity === 'warning') {
      findings.push({
        id: 'live-csp-unsafe-inline', severity: 'warning',
        message: `Content-Security-Policy contains \`unsafe-inline\` in ${unsafeInline.directive} — inline <script>/onclick= XSS payloads execute as if CSP weren't there`,
        suggestion: 'Replace with a per-request nonce (script-src \'nonce-{nonce}\') or strict-dynamic.',
      });
    } else if (unsafeInline) {
      findings.push({
        id: 'live-csp-unsafe-inline-style-only', severity: 'info',
        message: `Content-Security-Policy contains \`unsafe-inline\` in ${unsafeInline.directive} only — inline styles cannot execute script, so this is lower risk than an inline-script hole`,
        suggestion: 'If practical, replace with a per-request nonce (style-src \'nonce-{nonce}\') to close even this smaller surface.',
      });
    }
  }

  if (!hsts) {
    findings.push({
      id: 'live-missing-hsts', severity: 'warning',
      message: 'No Strict-Transport-Security header on the live response — first-visit MITM downgrade is still possible',
      suggestion: 'Add Strict-Transport-Security: max-age=31536000; includeSubDomains; preload once HTTPS works everywhere.',
    });
  } else {
    const m = /max-age\s*=\s*(\d+)/i.exec(hsts);
    if (m && !Number.isNaN(Number(m[1])) && Number(m[1]) < HSTS_MIN_MAX_AGE) {
      findings.push({
        id: 'live-hsts-short', severity: 'warning',
        message: `Strict-Transport-Security max-age=${m[1]} — below Mozilla's 180-day (15552000) recommendation`,
        suggestion: 'Use max-age=31536000; includeSubDomains; preload.',
      });
    }
  }

  if (!xfo && !(csp && /frame-ancestors/i.test(csp))) {
    findings.push({
      id: 'live-missing-frame-options', severity: 'warning',
      message: 'No X-Frame-Options and no CSP frame-ancestors on the live response — clickjacking surface',
      suggestion: 'Add X-Frame-Options: DENY (or SAMEORIGIN), and/or frame-ancestors \'none\' in CSP.',
    });
  }

  if (!nosniff) {
    findings.push({
      id: 'live-missing-nosniff', severity: 'info',
      message: 'No X-Content-Type-Options header on the live response — legacy browsers may still MIME-sniff',
      suggestion: 'Add X-Content-Type-Options: nosniff.',
    });
  }

  if (acao === '*' && /\btrue\b/i.test(acac || '')) {
    findings.push({
      id: 'live-cors-wildcard-with-credentials', severity: 'error',
      message: 'Access-Control-Allow-Origin: * co-occurs with Access-Control-Allow-Credentials: true — cross-site credential theft surface',
      suggestion: 'Echo the request\'s Origin back only for a maintained allow-list, or drop Allow-Credentials.',
    });
  }

  return findings;
}

class WebHeadersModule extends BaseModule {
  constructor() {
    super(
      'webHeaders',
      'Web Headers — CSP/HSTS/XFO/CORS misconfig across Next.js, Vercel, Netlify, nginx, Apache, Caddy and server source in any language',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    // Hosted URL scan: no repo checked out, but the route fetched the page
    // once and shared it via config.livePage — check the ACTUAL response
    // headers instead of reading source. (Doctrine §4, one definition:
    // _liveHeaderChecks is also what website-scanner.ts's /api/scan/url
    // path is documented to need — see that file's header comment.)
    if (config && config.livePage) {
      this._runLive(config.livePage, result);
      return;
    }

    if (this._isUrlOnlyScan(config)) {
      // A URL-only scan (no projectRoot, or a `targetUrl`/`webUrl` hosted
      // scan) with no shared page fetch either — this module reads source
      // files, it cannot fabricate a pass for a URL it never looked at
      // (distinct from a REAL repo with genuinely no header config, below).
      this._notChecked(result, 'this module reads source files (header config), not a live URL — no project files or fetched page were provided for this scan');
      return;
    }

    // Shared walk from BaseModule — honours --diff/--pr scoping (KI #104).
    // '*' because header config has no single extension (_headers,
    // nginx.conf, vercel.json, …); the filename/content predicate is
    // applied on top of it exactly as the old private walk did.
    const files = this._collectFiles(projectRoot, ['*'], EXTRA_EXCLUDES)
      .filter((f) => this._isHeaderFile(f, path.basename(f)));

    if (files.length === 0) {
      result.addCheck('web-headers:no-files', true, {
        severity: 'info',
        message: 'No web-header config files found — skipping',
      });
      return;
    }

    result.addCheck('web-headers:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} web-header config file(s)`,
    });

    let totalIssues = 0;
    for (const file of files) {
      totalIssues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('web-headers:summary', true, {
      severity: 'info',
      message: `Web headers scan: ${files.length} file(s), ${totalIssues} issue(s)`,
    });
  }

  /**
   * Live-URL mode: `livePage` is `{ url, status, headers, html }` from ONE
   * shared fetch the route already made (config.livePage) — this module
   * never fetches on its own. `headers` is anything duck-typed like a
   * WHATWG `Headers` (a `.get(name)` method) or a plain object.
   */
  _runLive(livePage, result) {
    const findings = liveHeaderChecks(livePage && livePage.headers);
    for (const f of findings) {
      result.addCheck(`web-headers:${f.id}`, false, {
        severity: f.severity,
        message: f.message,
        suggestion: f.suggestion,
      });
    }
    result.addCheck('web-headers:live-summary', true, {
      severity: 'info',
      message: findings.length === 0
        ? 'Live security headers check: no issues found'
        : `Live security headers check: ${findings.length} issue(s) found on the fetched response`,
    });
  }

  _isHeaderFile(full, basename) {
    if (CONFIG_NAMES.includes(basename)) return true;
    const ext = path.extname(basename).toLowerCase();
    if (CONFIG_EXTENSIONS.includes(ext)) return true;
    const isDirectiveConfig = DIRECTIVE_CONFIG_NAMES.includes(basename);
    // Server source code (any language) that mentions a header this
    // module has a rule for, or a directive config that sets a header.
    if (isDirectiveConfig || SERVER_SOURCE_EXTS.has(ext)) {
      try {
        if (fs.statSync(full).size > MAX_SNIFF_BYTES) return false;
        const content = fs.readFileSync(full, 'utf-8');
        if (isDirectiveConfig) return HEADER_DIRECTIVE_RE.test(content);
        if (HEADER_HINTS.test(content)) return true;
      } catch { return false; } // error-ok — unreadable file: nothing to scan, the walk already listed it
    }
    return false;
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch { return 0; }

    const rel = repoRelative(projectRoot, file);

    // Skip the module's own source — its pattern strings match its own rules.
    const relUnix = rel.replace(/\\/g, '/');
    if (/(?:^|\/)src[\\/]modules[\\/]/.test(relUnix)) return 0;

    // Skip test/spec/fixture files entirely — CSP/CORS/header values embedded
    // in test fixtures (as escaped-string source-in-a-string, as template-
    // literal file content, or as inline object literals used to exercise
    // the detector) are not real deployed config. An earlier attempt fixed
    // this the same way as redos.js/cron-expression.js/prompt-safety.js — a
    // content-based "is the match inside a string literal" check — but that
    // broke 4 tests here specifically: unlike those modules' flagged
    // patterns (bare regex literals, bare env-var names — never normally
    // quoted in real code), a CSP/CORS header value is ALWAYS inside a
    // string literal in BOTH real code and fixtures, so "inside a string"
    // carries zero discriminating signal for this module. Path-based isTest
    // is the actual reliable signal here — it doesn't care whether a
    // fixture is represented via escaped quotes or a template literal, and
    // it's safe: every fixture target in tests/web-headers.test.js (and
    // friends) lives under os.tmpdir(), which never matches this pattern.
    // One definition of "is this a test path" — BaseModule's (doctrine §4).
    if (this._isTestPath(relUnix)) return 0;

    const lines = content.split(/\r?\n/);
    let issues = 0;
    const lowerContent = content.toLowerCase();

    // Track which headers appear somewhere in this file
    const seen = {
      csp: /content-security-policy/i.test(content),
      hsts: /strict-transport-security/i.test(content),
      xfo: /x-frame-options/i.test(content),
      frameAncestors: /frame-ancestors/i.test(content),
      nosniff: /x-content-type-options/i.test(content),
      helmetAllDefaults: /\bhelmet\s*\(\s*\)/.test(content),
    };

    // Pass 1: per-line rules
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Suppressor: `// web-headers-ok` on same line or previous line
      const prevLine = i > 0 ? lines[i - 1] : '';
      if (/\bweb-headers-ok\b/.test(line) || /\bweb-headers-ok\b/.test(prevLine)) continue;

      // A comment line ("// NO 'unsafe-eval'") mentions the directive
      // without setting it — do not let it fire the CSP token checks below.
      if (_isCommentLine(trimmed)) continue;

      // CSP: unsafe-eval / unsafe-inline. Look only on lines that
      // include a CSP directive marker.
      if (/content-security-policy|frame-ancestors|default-src|script-src|style-src|object-src/i.test(line)) {
        if (CSP_UNSAFE_EVAL_TOKEN.test(line)) {
          issues += this._flag(result, `web-headers:csp-unsafe-eval:${rel}:${i + 1}`, {
            // isTest files return 0 above, before this line is reachable.
            severity: 'error',
            file: rel,
            line: i + 1,
            message: 'Content-Security-Policy contains `unsafe-eval` — re-enables `eval()`/`new Function()` and the entire class of attacks CSP is supposed to block',
            suggestion: 'Refactor away from eval (bundlers, template engines, JSON.parse). If you truly need it for a known script, use a strict-dynamic + nonce CSP instead.',
          });
        }
        if (/['"`]?unsafe-inline['"`]?/i.test(line)) {
          issues += this._flag(result, `web-headers:csp-unsafe-inline:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            message: 'Content-Security-Policy contains `unsafe-inline` — inline `<script>` / `onclick=` XSS payloads execute as if CSP weren\'t there',
            suggestion: 'Replace with a per-request nonce (`script-src \'nonce-{nonce}\'`) or strict-dynamic. Move inline handlers to addEventListener.',
          });
        }
      }

      // HSTS max-age check
      const hstsMatch = line.match(/max-age\s*=\s*(\d+)/i);
      if (hstsMatch && /strict-transport-security/i.test(lowerContent.slice(
        Math.max(0, content.toLowerCase().indexOf(line.toLowerCase()) - 200),
        content.toLowerCase().indexOf(line.toLowerCase()) + line.length,
      ))) {
        const val = parseInt(hstsMatch[1], 10);
        if (!Number.isNaN(val) && val < HSTS_MIN_MAX_AGE) {
          issues += this._flag(result, `web-headers:hsts-short:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            maxAge: val,
            message: `Strict-Transport-Security max-age=${val} — below Mozilla's 180-day (15552000) recommendation`,
            suggestion: 'Use `max-age=31536000; includeSubDomains; preload` once you\'re confident HTTPS works everywhere.',
          });
        }
      }
    }

    // Pass 2: CORS wildcard + credentials co-occurrence (file-level)
    // The separator class covers every assignment shape a header value can
    // follow: `: '*'`, `, "*"` (Set/setHeader), `'] = '*'` (Flask / Rack
    // dict subscript), `) = "*"`, and a bare ` *` (Caddy, Apache).
    const hasWildcardOrigin = /access-control-allow-origin["'\s:,\]=)]+\*/i.test(content);
    const hasCredentialsTrue = /access-control-allow-credentials["'\s:,\]=)]+true/i.test(content);
    if (hasWildcardOrigin && hasCredentialsTrue) {
      const idx = content.search(/access-control-allow-origin/i);
      const lineNo = content.slice(0, Math.max(0, idx)).split(/\r?\n/).length;
      issues += this._flag(result, `web-headers:cors-wildcard-with-credentials:${rel}:${lineNo}`, {
        // isTest files return 0 above, before this line is reachable.
        severity: 'error',
        file: rel,
        line: lineNo,
        message: '`Access-Control-Allow-Origin: *` co-occurs with `Access-Control-Allow-Credentials: true` — cross-site credential theft surface, and browsers should (but don\'t always) reject it',
        suggestion: 'Echo the request\'s `Origin` back only for a maintained allow-list of origins, or drop `Allow-Credentials`.',
      });
    }

    // Pass 3: missing-header warnings — ONLY for files that appear to
    // be deliberately setting *some* headers (otherwise a middleware
    // file that uses res.setHeader for one thing gets spammed).
    const looksLikeHeaderConfig =
      CONFIG_NAMES.includes(path.basename(file)) ||
      CONFIG_EXTENSIONS.includes(path.extname(file).toLowerCase()) ||
      // an `.htaccess` / Caddyfile only reaches here when it carries a
      // header directive (see _isHeaderFile), so it IS header config
      DIRECTIVE_CONFIG_NAMES.includes(path.basename(file)) ||
      /(?:async\s+)?headers\s*\(\s*\)\s*{/.test(content);

    if (looksLikeHeaderConfig) {
      if (!seen.csp) {
        issues += this._flag(result, `web-headers:missing-csp:${rel}`, {
          severity: 'warning',
          file: rel,
          message: `${rel} sets response headers but no Content-Security-Policy — XSS payloads run with the full permissions of the origin`,
          suggestion: 'Add a strict CSP starting from `default-src \'self\'; script-src \'self\'` and open only what you need.',
        });
      }
      if (!seen.hsts) {
        issues += this._flag(result, `web-headers:missing-hsts:${rel}`, {
          severity: 'warning',
          file: rel,
          message: `${rel} sets response headers but no Strict-Transport-Security — first-visit MITM downgrade is still possible`,
          suggestion: 'Add `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` once HTTPS is universal.',
        });
      }
      if (!seen.xfo && !seen.frameAncestors) {
        issues += this._flag(result, `web-headers:missing-frame-options:${rel}`, {
          severity: 'warning',
          file: rel,
          message: `${rel} sets response headers but no X-Frame-Options and no CSP frame-ancestors — clickjacking surface`,
          suggestion: 'Add `X-Frame-Options: DENY` (or `SAMEORIGIN`), and `frame-ancestors \'none\'` in CSP.',
        });
      }
      if (!seen.nosniff) {
        issues += this._flag(result, `web-headers:missing-nosniff:${rel}`, {
          severity: 'info',
          file: rel,
          message: `${rel} sets response headers but no X-Content-Type-Options — legacy browsers may still MIME-sniff`,
          suggestion: 'Add `X-Content-Type-Options: nosniff`.',
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

module.exports = WebHeadersModule;
module.exports.liveHeaderChecks = liveHeaderChecks;
