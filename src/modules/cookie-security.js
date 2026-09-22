/**
 * Cookie / Session-Security Config Detector Module.
 *
 * Misconfigured session cookies are the gift that keeps on giving: a
 * `httpOnly: false` cookie carrying the session id is readable from any
 * injected JS (XSS → session takeover); a `secure: false` flag lets the
 * cookie ride over plain HTTP where a network attacker can read it; a
 * `SESSION_COOKIE_HTTPONLY = False` on a Django site means `document
 * .cookie` on a third-party page running in an iframe can read
 * everything. Audit reports find these in production all the time —
 * they persist because frameworks default to secure but individual
 * overrides slip in and never get reviewed.
 *
 * We catch the unambiguous misconfigurations — where the security flag
 * is *explicitly* set to off, or where the session secret is an obvious
 * placeholder that shipped without being replaced.
 *
 *   JS/TS:
 *     - `httpOnly: false` in cookie / session options — error (XSS risk)
 *     - `secure: false` in cookie / session options — warning
 *     - `sameSite: 'none'` with no `secure: true` nearby — warning
 *     - `secret: '<known-weak>'` — obvious placeholder secret — error
 *
 *   Python (Flask / Django / FastAPI):
 *     - `SESSION_COOKIE_SECURE = False` — warning
 *     - `SESSION_COOKIE_HTTPONLY = False` — error
 *     - `CSRF_COOKIE_SECURE = False` — warning
 *     - `CSRF_COOKIE_HTTPONLY = False` — error
 *     - `httponly=False` (FastAPI / Starlette `set_cookie`) — error
 *
 * Rules:
 *
 *   error:   JS `httpOnly: false` in cookie / session options.
 *            (rule: `cookie-sec:js-httponly-false:<rel>:<line>`)
 *
 *   warning: JS `secure: false` in cookie / session options.
 *            (rule: `cookie-sec:js-secure-false:<rel>:<line>`)
 *
 *   error:   JS `secret: '<weak>'` where `<weak>` is a known-weak
 *            placeholder (`'changeme'`, `'secret'`, `'default'`,
 *            `'password'`, `'keyboard cat'`, `'test'`, `'mysecret'`,
 *            `'sessionsecret'`, `'abcd1234'`).
 *            (rule: `cookie-sec:js-weak-secret:<rel>:<line>`)
 *
 *   warning: Python `SESSION_COOKIE_SECURE = False` /
 *            `CSRF_COOKIE_SECURE = False`.
 *            (rule: `cookie-sec:py-cookie-secure-false:<rel>:<line>`)
 *
 *   error:   Python `SESSION_COOKIE_HTTPONLY = False` / `httponly=False`
 *            kwarg.
 *            (rule: `cookie-sec:py-cookie-httponly-false:<rel>:<line>`)
 *
 *   warning: Python `CSRF_COOKIE_HTTPONLY = False`. Django's documented
 *            default IS False, and its docs say why: the CSRF token is
 *            not a session credential, JS on the page legitimately reads
 *            it for AJAX, and HttpOnly on it "doesn't offer any practical
 *            protection" (the token is in the DOM anyway). Worth a look
 *            when someone wrote it out explicitly; not a gate.
 *            (rule: `cookie-sec:py-cookie-httponly-false:<rel>:<line>`)
 *
 * Suppressions:
 *   - `// cookie-ok` / `# cookie-ok` on same or preceding line.
 *   - Test / spec / fixture paths downgrade error → warning,
 *     warning → info.
 *   - A FRAMEWORK DEFAULTS file (`global_settings.py`,
 *     `default_settings.py`, `defaults.py`, `settings_defaults.py`)
 *     downgrades every Python cookie rule to info. That file DEFINES the
 *     setting; an application misconfigures it in its own `settings.py`.
 *     django/django's `django/conf/global_settings.py:581`
 *     (`CSRF_COOKIE_HTTPONLY = False`, the framework's own default) was
 *     gate-BLOCKING at confidence 1.0 on 2026-09-14.
 *
 * Competitors:
 *   - OWASP ZAP catches insecure cookies at runtime — requires a
 *     deployed env. Not a pre-merge gate.
 *   - Bandit has `hardcoded_password_string` (weak-secret adjacent)
 *     but nothing on SESSION_COOKIE_* flags.
 *   - SonarQube has one JS rule on `secure: false` and one on
 *     `httpOnly: false` but misses Python framework configs entirely.
 *   - ESLint / Pylint / Ruff have nothing on session-cookie config.
 *   - Nothing unifies Express / Next / Flask / Django / FastAPI
 *     session-cookie config at the gate with placeholder-secret
 *     detection.
 *
 * TODO(gluecron): host-neutral — pure static scan.
 */

const BaseModule = require('./base-module');
const { SESSION_MIDDLEWARE_RE } = require('../core/route-grammar');
const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');

const JS_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
]);
const PY_EXTS = new Set(['.py']);


const SUPPRESS_RE = /\bcookie-ok\b/;

// JS/TS patterns — every one is matched on the MASKED line
// (BaseModule._maskedLines): string, template, regex and comment bodies are
// blanked there, so `httpOnly: false` in a docstring, in a fixture string,
// or in a test's `assert.match(out, /httpOnly: false/)` cannot fire
// (self-scan 2026-07-15), and neither can one in a block comment or template
// literal that started on an earlier line (2026-09-05).
const JS_HTTPONLY_FALSE_RE = /\bhttpOnly\s*:\s*false\b/;
const JS_SECURE_FALSE_RE = /\bsecure\s*:\s*false\b/;
// Weak session secret — known placeholder values. The value is a string
// body, blanked on the masked line, so the SHAPE (`secret: '`) is matched
// there and the placeholder is then read from the raw line at the same
// offset (the mask preserves offsets; sticky regex). A weak secret nested
// inside ANOTHER string is fixture data — its opening quote is blanked, so
// the shape never matches (this rule flagged its own test file's sample
// payloads, self-scan 2026-07-15).
const JS_WEAK_SECRET_SHAPE_RE = /\bsecret\s*:\s*['"]/;
const JS_WEAK_SECRET_RE =
  /\bsecret\s*:\s*['"](changeme|secret|default|password|keyboard cat|test|mysecret|sessionsecret|session-secret|abcd1234|foo|bar|change[_-]?me|your[_-]?secret[_-]?here|replace[_-]?me)['"]/iy;

const JS_RULES = [
  { re: JS_HTTPONLY_FALSE_RE, id: 'js-httponly-false', sev: 'err', message: '`httpOnly: false` on a session cookie — readable from JS. XSS becomes session takeover.' },
  { re: JS_SECURE_FALSE_RE, id: 'js-secure-false', sev: 'warn', message: '`secure: false` allows the cookie over plain HTTP — a network attacker can read it.' },
];

// Python patterns.
const PY_COOKIE_SECURE_FALSE_RE =
  /^\s*(SESSION_COOKIE_SECURE|CSRF_COOKIE_SECURE)\s*=\s*False\b/;
const PY_COOKIE_HTTPONLY_FALSE_RE =
  /^\s*(SESSION_COOKIE_HTTPONLY|CSRF_COOKIE_HTTPONLY)\s*=\s*False\b/;
// FastAPI / Starlette set_cookie kwarg: `httponly=False`.
const PY_HTTPONLY_KWARG_FALSE_RE = /[,(]\s*httponly\s*=\s*False\b/;

// The file that DEFINES a framework's settings defaults, by basename. Django
// ships `django/conf/global_settings.py`; the other spellings are the
// conventions Flask extensions, Pyramid and Wagtail use. A default written
// here is the framework's documented starting point — an application changes
// it in its own `settings.py`, which is where a misconfiguration would live.
const PY_FRAMEWORK_DEFAULTS_RE = /(?:^|\/)(?:global_settings|default_settings|settings_defaults|defaults)\.py$/i;

// Django documents CSRF_COOKIE_HTTPONLY = False as the default and explains
// that HttpOnly on the CSRF cookie "doesn't offer any practical protection":
// the token is not a session credential, page JS reads it for AJAX, and it is
// in the DOM regardless. Written out explicitly it is worth a look, not a gate.
const PY_CSRF_HTTPONLY_SETTING = 'CSRF_COOKIE_HTTPONLY';

/** Every `Set-Cookie` header on a fetched response — a WHATWG `Headers`
 *  (`.getSetCookie()`, falling back to `.get()` for a single value on older
 *  runtimes) or a plain `{ 'set-cookie': string | string[] }` object. */
function _getSetCookies(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  if (typeof headers.get === 'function') {
    const v = headers.get('set-cookie');
    return v ? [v] : [];
  }
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'set-cookie');
  if (!key) return [];
  const v = headers[key];
  return Array.isArray(v) ? v : [v];
}

/**
 * Live-response equivalent of the static `httpOnly:false` / `secure:false`
 * rules: read the ACTUAL `Set-Cookie` flags from one already-fetched
 * response instead of source. Exported so `/api/scan/url` and the hosted
 * web scan share one definition (Doctrine §4).
 *
 * @param {unknown} headers
 * @returns {Array<{id:string, severity:'error'|'warning'|'info', message:string, suggestion:string}>}
 */
function liveCookieChecks(headers) {
  const findings = [];
  const cookies = _getSetCookies(headers);
  for (const raw of cookies) {
    if (typeof raw !== 'string' || !raw) continue;
    const name = (raw.split('=')[0] || 'cookie').trim() || 'cookie';
    const hasSecure = /;\s*Secure\b/i.test(raw);
    if (!/;\s*HttpOnly\b/i.test(raw)) {
      findings.push({
        id: `live-httponly-missing:${name}`, severity: 'warning',
        message: `Cookie "${name}" has no HttpOnly flag on the live response — readable from JS; an XSS bug becomes session takeover`,
        suggestion: `Add the HttpOnly flag: Set-Cookie: ${name}=...; HttpOnly; Secure; SameSite=Lax`,
      });
    }
    if (!hasSecure) {
      findings.push({
        id: `live-secure-missing:${name}`, severity: 'warning',
        message: `Cookie "${name}" has no Secure flag on the live response — can be sent over plain HTTP`,
        suggestion: `Add the Secure flag: Set-Cookie: ${name}=...; HttpOnly; Secure; SameSite=Lax`,
      });
    }
    if (/;\s*SameSite\s*=\s*None/i.test(raw) && !hasSecure) {
      findings.push({
        id: `live-samesite-none-insecure:${name}`, severity: 'warning',
        message: `Cookie "${name}" sets SameSite=None without Secure — browsers reject or drop this combination`,
        suggestion: 'Pair SameSite=None with the Secure flag.',
      });
    }
  }
  return findings;
}

class CookieSecurityModule extends BaseModule {
  constructor() {
    super(
      'cookieSecurity',
      'Cookie / session-security config detector — catches httpOnly:false, weak session secrets, SESSION_COOKIE_* misconfigs'
    );
  }

  async run(result, config) {
    // Hosted URL scan: the route fetched the page once and shared the
    // response headers via config.livePage — Set-Cookie flags (HttpOnly /
    // Secure / SameSite) are visible there without any source to read.
    if (config && config.livePage) {
      this._runLive(config.livePage, result);
      return;
    }

    if (this._isUrlOnlyScan(config)) {
      this._notChecked(result, 'this module reads source files (session/cookie config), not a live URL — no project files or fetched page were provided for this scan');
      return;
    }

    const projectRoot = config.projectRoot;
    const files = this._collect(projectRoot);

    if (files.length === 0) {
      result.addCheck('cookie-sec:no-files', true, {
        severity: 'info',
        message: 'No source files to scan',
      });
      return;
    }

    result.addCheck('cookie-sec:scanning', true, {
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
        issues += this._checkSessionCookieConfig(rel, text, result);
      } else if (PY_EXTS.has(ext)) {
        issues += this._scanPy(rel, text, result);
      }
    }

    result.addCheck('cookie-sec:summary', true, {
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

  /** Live-URL mode: `livePage` is `{ url, status, headers, html }` from ONE
   *  shared fetch the route already made (config.livePage). */
  _runLive(livePage, result) {
    const findings = liveCookieChecks(livePage && livePage.headers);
    for (const f of findings) {
      result.addCheck(`cookie-sec:${f.id}`, false, {
        severity: f.severity,
        message: f.message,
        suggestion: f.suggestion,
      });
    }
    result.addCheck('cookie-sec:live-summary', true, {
      severity: 'info',
      message: findings.length === 0
        ? 'Live cookie check: no Set-Cookie flag issues found (or the response set no cookies)'
        : `Live cookie check: ${findings.length} issue(s) found on the fetched response`,
    });
  }

  /**
   * The ABSENT flag, not just the false one. `session({ cookie: { … } })`
   * that never says `secure: true` ships the session id over plain HTTP —
   * express-session's default is secure:false, and the classic planted
   * form is `// secure: true` left commented out (NodeGoat A5; 2026-08-18
   * audit advancement #6 — "cookie flags" was a recall miss because the
   * line rules only fire on an explicit `secure: false`).
   *
   * Comments are blanked (newlines preserved, so line numbers hold) before
   * the check — a commented-out flag is an absent flag.
   */
  _checkSessionCookieConfig(rel, text, result) {
    // Both module systems: the CommonJS-only test let every ESM
    // `import session from 'express-session'` skip this rule (2026-09-05).
    if (!SESSION_MIDDLEWARE_RE.test(text)) return 0;
    const live = text
      .replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, ' ');
    const m = live.match(/\bsession\s*\(\s*\{/);
    if (!m) return 0;
    const start = live.indexOf('{', m.index);
    let depth = 0;
    let end = -1;
    for (let i = start; i < Math.min(live.length, start + 8000); i += 1) {
      const c = live[i];
      if (c === '{') depth += 1;
      else if (c === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return 0;
    const block = live.slice(start, end + 1);
    // An explicit `secure: false` is the existing js-secure-false line
    // rule's job; `secure: true` (or the express-session 'auto' mode) is
    // configured. Only the ABSENT case is ours.
    if (/secure\s*:/.test(block)) return 0;
    const line = live.slice(0, m.index).split(/\r?\n/).length;
    // Example/demo apps teach the shape, they don't ship it — info, so a
    // library repo's examples/ dir (expressjs/express has four) doesn't
    // read as four security warnings.
    const isExample = /(^|\/)(examples?|samples?|demos?)\//.test(rel);
    const warnSev = this._isTestPath(rel) || isExample ? 'info' : 'warning';
    result.addCheck(`cookie-sec:js-session-secure-absent:${rel}:${line}`, false, {
      severity: warnSev,
      message: 'session cookie config never sets `secure: true` — the session id will be sent over plain HTTP (a commented-out flag is an absent flag)',
      file: rel,
      line,
      fix: 'Set `cookie: { secure: true }` (behind a proxy also set `app.set("trust proxy", 1)`), or `secure: "auto"`.',
    });
    return 1;
  }

  _scanJs(rel, text, result) {
    const isTest = this._isTestPath(rel);
    const errSev = isTest ? 'warning' : 'error';
    const warnSev = isTest ? 'info' : 'warning';
    const lines = text.split(/\r?\n/);
    const masked = this._maskedLines(text);
    let issues = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];        // raw: the secret's value, `cookie-ok` markers
      const code = masked[i] || ''; // masked: every pattern match
      if (this._suppressed(lines, i)) continue;

      for (const rule of JS_RULES) {
        if (!rule.re.test(code)) continue;
        result.addCheck(`cookie-sec:${rule.id}:${rel}:${i + 1}`, false, {
          severity: rule.sev === 'err' ? errSev : warnSev,
          message: rule.message,
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }

      const weakMatch = this._matchOnRaw(code, line, JS_WEAK_SECRET_SHAPE_RE, JS_WEAK_SECRET_RE);
      if (weakMatch) {
        result.addCheck(`cookie-sec:js-weak-secret:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: `Session secret is a known-weak placeholder ("${weakMatch[1]}") — replace before deploy.`,
          file: rel,
          line: i + 1,
          value: weakMatch[1],
        });
        issues += 1;
      }
    }
    return issues;
  }

  _scanPy(rel, text, result) {
    const isTest = this._isTestPath(rel);
    // A framework's defaults file defines the setting rather than deploying
    // it — every rule drops to info there, and the message says so.
    const isDefaults = PY_FRAMEWORK_DEFAULTS_RE.test(String(rel).replace(/\\/g, '/'));
    const errSev = isDefaults ? 'info' : isTest ? 'warning' : 'error';
    const warnSev = isDefaults || isTest ? 'info' : 'warning';
    const defaultsNote = isDefaults
      ? ' This is a framework defaults file — it defines the setting; the application overrides it in its own settings.'
      : '';
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

      const m1 = PY_COOKIE_SECURE_FALSE_RE.exec(codeLine);
      if (m1) {
        result.addCheck(`cookie-sec:py-cookie-secure-false:${rel}:${i + 1}`, false, {
          severity: warnSev,
          message: `\`${m1[1]} = False\` — cookie will ride over plain HTTP. Network attacker can read it.${defaultsNote}`,
          file: rel,
          line: i + 1,
          setting: m1[1],
        });
        issues += 1;
      }
      const m2 = PY_COOKIE_HTTPONLY_FALSE_RE.exec(codeLine);
      if (m2) {
        const isCsrf = m2[1] === PY_CSRF_HTTPONLY_SETTING;
        result.addCheck(`cookie-sec:py-cookie-httponly-false:${rel}:${i + 1}`, false, {
          severity: isCsrf ? warnSev : errSev,
          message: isCsrf
            ? `\`${m2[1]} = False\` — Django's documented default; HttpOnly on the CSRF cookie adds no practical protection (the token is in the DOM and page JS reads it for AJAX). Confirm it was meant, not a gate.${defaultsNote}`
            : `\`${m2[1]} = False\` — cookie readable from JS. XSS becomes session takeover.${defaultsNote}`,
          file: rel,
          line: i + 1,
          setting: m2[1],
        });
        issues += 1;
      }
      if (PY_HTTPONLY_KWARG_FALSE_RE.test(codeLine)) {
        result.addCheck(`cookie-sec:py-fastapi-httponly-false:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: `\`httponly=False\` on a Response.set_cookie / Starlette cookie — readable from JS.${defaultsNote}`,
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

module.exports = CookieSecurityModule;
module.exports.liveCookieChecks = liveCookieChecks;
