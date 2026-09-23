'use strict';

/**
 * One shared definition (Doctrine #4) of directive-aware CSP analysis.
 *
 * Issue #681 item 3: both the server scanner
 * (`src/scanners/server-scanner.js`) and the live header check
 * (`src/modules/web-headers.js`) tested the WHOLE CSP header string for
 * `'unsafe-inline'`, so a site serving
 * `script-src 'self' 'nonce-…'` (scripts locked down with a nonce) and
 * keeping `'unsafe-inline'` only in `style-src` (a deliberate, documented
 * choice for inline style assets — no XSS risk, since `'unsafe-inline'` in
 * `style-src` cannot execute script) got the exact same warning as a site
 * that actually allows inline `<script>` execution.
 */

/**
 * Parse a CSP header value into a directive -> raw source-list map.
 * Directive names are lower-cased; source tokens are returned verbatim
 * (quotes intact) so callers can literal-match `'unsafe-inline'`.
 *
 * @param {string} csp
 * @returns {Record<string, string[]>}
 */
function parseCsp(csp) {
  const directives = {};
  if (!csp || typeof csp !== 'string') return directives;
  for (const part of csp.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const name = (tokens[0] || '').toLowerCase();
    if (!name) continue;
    directives[name] = tokens.slice(1);
  }
  return directives;
}

/** Directives whose `'unsafe-inline'` governs SCRIPT execution — the XSS-relevant set. */
const SCRIPT_AFFECTING_DIRECTIVES = new Set(['script-src', 'script-src-elem', 'script-src-attr']);

function directiveHasUnsafeInline(directives, name) {
  const tokens = directives[name];
  return Array.isArray(tokens) && tokens.some((t) => t.toLowerCase() === "'unsafe-inline'");
}

/**
 * Directive-aware classification of `'unsafe-inline'` in a CSP header.
 *
 *   - Present in `script-src` (or a script-src-elem/attr variant): WARNING —
 *     inline `<script>`/`onclick=` XSS payloads execute as if CSP weren't
 *     there.
 *   - No `script-src` at all, but `default-src` carries it: WARNING —
 *     CSP's own fallback-list semantics mean `default-src` governs script
 *     execution when `script-src` is absent.
 *   - Present ONLY in `style-src` (script-src/default-src either absent
 *     the token or absent entirely): INFO, naming the directive — inline
 *     styles cannot execute script, so this is a lower-severity note, not
 *     the same warning as inline scripts.
 *
 * @param {string} csp raw CSP header value
 * @returns {{ severity: 'warning'|'info', directive: string } | null} `null`
 *   when `'unsafe-inline'` does not appear in any directive.
 */
function classifyUnsafeInline(csp) {
  if (!csp || typeof csp !== 'string' || !/unsafe-inline/i.test(csp)) return null;
  const directives = parseCsp(csp);

  for (const name of SCRIPT_AFFECTING_DIRECTIVES) {
    if (directiveHasUnsafeInline(directives, name)) return { severity: 'warning', directive: name };
  }
  // CSP fallback semantics: `default-src` governs script-src when
  // script-src itself is not declared at all (its mere presence, even
  // without 'unsafe-inline', would already take over from default-src).
  if (!('script-src' in directives) && directiveHasUnsafeInline(directives, 'default-src')) {
    return { severity: 'warning', directive: 'default-src' };
  }
  if (directiveHasUnsafeInline(directives, 'style-src')) {
    return { severity: 'info', directive: 'style-src' };
  }
  // 'unsafe-inline' showed up somewhere else the fast /unsafe-inline/i test
  // caught (e.g. a directive we don't special-case) — never silently drop
  // a real signal; report it against whichever directive actually carries it.
  for (const [name, tokens] of Object.entries(directives)) {
    if (Array.isArray(tokens) && tokens.some((t) => t.toLowerCase() === "'unsafe-inline'")) {
      return { severity: 'info', directive: name };
    }
  }
  return null;
}

module.exports = { parseCsp, classifyUnsafeInline, SCRIPT_AFFECTING_DIRECTIVES };
