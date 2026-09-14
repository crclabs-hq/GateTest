/**
 * Hardcoded-URL / Localhost / Private-IP Leak Module.
 *
 * The developer tests against a local service, commits `localhost:3000`
 * inline, and the string makes it through review, CI, and into prod.
 * In prod the URL dead-ends, the call 500s, and a feature that
 * "worked on my machine" is broken for every user.
 *
 * Variants:
 *   - `http://localhost:3000` / `http://127.0.0.1:8080`
 *   - `http://10.x.x.x`, `http://172.16-31.x.x`, `http://192.168.x.x`
 *     (RFC1918) committed to source
 *   - internal staging hostnames (`.internal`, `.local`, `.lan`,
 *     `.staging`, `.dev.mycompany.com`) baked in
 *   - personal IP addresses (the developer's laptop)
 *   - `http://` (non-TLS) in production code — downgrade attacks
 *
 * Legitimate exceptions (must NOT false-positive):
 *   - test / spec / fixture files
 *   - storybook files
 *   - `.env.example`, `.env.local`, docs, README
 *   - dev-only config blocks guarded by `NODE_ENV !== 'production'`
 *   - constants explicitly named `DEV_URL` / `LOCAL_URL` / `TEST_URL`
 *   - URLs inside block/line comments
 *   - `localhost` inside config schema descriptions / JSDoc
 *
 * Competitors:
 *   - ESLint doesn't catch it.
 *   - Semgrep has a localhost rule but no RFC1918 / staging coverage.
 *   - SonarQube has one 127.0.0.1 rule, nothing else.
 *   - Nothing unifies localhost + RFC1918 + internal-TLD + non-TLS.
 *
 * Rules:
 *
 *   error:   Hardcoded `http://localhost` / `http://127.0.0.1` /
 *            `http://0.0.0.0` in non-test production source.
 *            (rule: `hardcoded-url:localhost:<rel>:<line>`)
 *
 *   error:   Hardcoded RFC1918 private-range URL
 *            (10/8, 172.16/12, 192.168/16, 169.254/16) in non-test
 *            production source — usually a developer's internal IP.
 *            (rule: `hardcoded-url:private-ip:<rel>:<line>`)
 *
 *   warning: Hardcoded internal-TLD URL (`.internal`, `.local`,
 *            `.lan`, `.corp`, `.intra`) or staging hostname
 *            (`staging.`, `dev.`, `test.`, `qa.`) in production source.
 *            (rule: `hardcoded-url:internal-tld:<rel>:<line>`)
 *
 *   warning: Hardcoded `http://` (non-TLS) external URL in
 *            production source — downgrade vector / mixed content.
 *            (rule: `hardcoded-url:insecure-scheme:<rel>:<line>`)
 *
 * TODO(gluecron): host-neutral — pure source scan.
 */

const fs = require('fs');
const { literalKindAt } = require('../core/source-strip');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const { isNonUserFacingPage } = require('../core/scan-scope');
const BaseModule = require('./base-module');

// Directory excludes beyond what `BaseModule._collectFiles` already skips
// (node_modules, .git, dist, build, coverage, .next, out, …). The old
// private walk (removed under KI #104) also skipped these.
const EXTRA_EXCLUDES = ['.terraform'];

const SOURCE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

// Filenames we skip entirely (config examples, docs, local dev infra).
const SKIP_BASENAME_RE = /^(?:\.env(\..*)?|.*\.example|.*\.md|.*\.mdx|README.*|CHANGELOG.*|MIGRATION.*|playwright\.config\..*|vitest\.config\..*|jest\.config\..*|cypress\.config\..*|webpack\.config\..*|vite\.config\..*|rollup\.config\..*)$/i;

// URL-shaped capture. We match `<scheme>://<host>[:port][/path]`.
const URL_RE = /\b(https?):\/\/([A-Za-z0-9_.-]+(?::\d+)?)(\/[^\s'"`)]*)?/g;

// RFC1918 + link-local + loopback host shapes.
// 10.x, 172.16-31.x, 192.168.x, 169.254.x, 127.x, 0.0.0.0
const PRIVATE_IP_RE = /^(?:10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+)(?::\d+)?$/;
const LOCALHOST_RE = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1)(?::\d+)?$/i;

// Internal TLDs + common staging subdomain prefixes.
const INTERNAL_TLD_RE = /\.(?:internal|local|lan|corp|intra|localhost|test|example)(?::\d+)?$/i;
const STAGING_HOST_RE = /^(?:staging|stage|dev|test|qa|uat|preprod|pre-prod)\.[A-Za-z0-9_.-]+$/i;

// Variable-name hints that say "this is deliberately dev-only".
const DEV_CONTEXT_LINE_RE = /\b(?:DEV|LOCAL|DEVELOPMENT|TEST|DEBUG|E2E_BASE_URL|MOCK|STUB|FIXTURE|STORYBOOK)[A-Z_]*(?:_URL|_HOST|_ENDPOINT|_BASE|_API)?\b/;

// Dev-guard: `if (process.env.NODE_ENV !== 'production')` / `!== "prod"`
// on the current or a recent line.
// `case 'development':` in a `switch (VERCEL_ENV / NODE_ENV)` is the same
// guard written as a switch (trpc www/src/utils/env.js:41-42).
const DEV_GUARD_RE = /\bprocess\.env\.NODE_ENV\s*(?:===|!==|==|!=)\s*['"`](?:development|dev|test|local|staging)['"`]|NODE_ENV\s*(?:===|!==|==|!=)\s*['"`]production['"`]|__DEV__\b|isDev(?:elopment)?\b|isLocal\b|isTest\b|\bcase\s+['"`](?:development|dev|local|test)['"`]\s*:/;

// The "use env in prod, localhost in dev" pattern in its OTHER spellings —
// each one measured on a real repo and reported as a leak:
//   ternary across lines — `process.env.VERCEL_URL ? 'https://' + … : 'http://localhost:3000'`
//     (trpc www/og-image/pages/api/_ref/vercel.tsx:36-38, utils/fetchFont.ts:3-5)
//   schema default        — zod/joi/yup `.default('http://localhost:3000')`, envalid `devDefault:`
//     (trpc www/src/utils/env.js:16) — a documented dev default IS the fix this rule suggests
//   the bound address     — `server.listen(PORT, () => log(`http://localhost:${PORT}`))`
//     (prisma apps/lsp-playground/src/cli.ts:256-257) — a server announcing where it is listening
//   WHATWG parse base     — `new URL(req.url, 'http://localhost')`, `location.href || 'http://localhost'`: the host is discarded
//     (prisma apps/lsp-playground/src/cli.ts:15 → :30)
const ENV_TERNARY_RE = /\bprocess\.env\.[A-Z_][A-Z0-9_]*\s*\?[^;]*?:\s*['"`]$/;
const SCHEMA_DEFAULT_RE = /\.(?:default|devDefault)\s*\(\s*['"`]$|\bdevDefault\s*:\s*['"`]$/;
const LISTEN_RE = /\.listen\s*\(/;
const BARE_LOCALHOST_RE = /^https?:\/\/localhost\/?['"`]/i;

// `before` and `maskedContent` are the masked text (the parse-base call is
// code); `line` is raw because the `'http://localhost` it looks for is the
// string's own content.
function isUrlParseBase(line, before, maskedContent) {
  if (/\bnew\s+URL\s*\([^,]+,\s*['"`]$/.test(before)) return true;
  // The fallback of a browser location — `window.location.href ||
  // 'http://localhost'`, `document.baseURI ?? 'http://localhost'` — is the
  // origin a relative URL resolves against when there is no window (axios
  // lib/platform/common/utils.js; #418's corpus run, 2026-09-02). A bare
  // host anywhere else — a fetch target, a non-env ternary — still fires:
  // tests/hardcoded-url.test.js holds that control pair.
  if (/\b(?:href|origin|baseURI|location)\)*\s*(?:\|\||\?\?)\s*['"`]$/.test(before)) return true;
  const decl = line.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`]https?:\/\/localhost/);
  return !!decl && new RegExp(`\\bnew\\s+URL\\s*\\([^,]+,\\s*${decl[1]}\\b`).test(maskedContent);
}

// Documentation-URL allowlist — common examples.
const DOC_ALLOWLIST = new Set([
  'example.com',
  'www.example.com',
  'example.org',
  'example.net',
  'your-domain.com',
  'yourdomain.com',
  'mydomain.com',
  'foo.com',
  'bar.com',
]);


class HardcodedUrlModule extends BaseModule {
  constructor() {
    super(
      'hardcodedUrl',
      'Hardcoded-URL detector — localhost / 127.0.0.1 / RFC1918 / internal TLDs / non-TLS URLs leaking into production code',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    // Shared walk from BaseModule — honours --diff/--pr scoping (KI #104);
    // the basename skip-list is applied on top of it.
    const files = this._collectFiles(projectRoot, [...SOURCE_EXTS], EXTRA_EXCLUDES)
      .filter((f) => !SKIP_BASENAME_RE.test(path.basename(f)));

    if (files.length === 0) {
      result.addCheck('hardcoded-url:no-files', true, {
        severity: 'info',
        message: 'No JS/TS source files found — skipping',
      });
      return;
    }

    result.addCheck('hardcoded-url:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} JS/TS file(s) for hardcoded URLs`,
    });

    let issues = 0;
    for (const file of files) {
      issues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('hardcoded-url:summary', true, {
      severity: 'info',
      message: `Hardcoded-URL scan: ${files.length} file(s), ${issues} issue(s)`,
    });
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return 0; }

    const rel = repoRelative(projectRoot, file);
    // Illustration directories join test files here rather than being skipped:
    // a `localhost` URL in `examples/server.js` or `sandbox/client.js` is the
    // demo working as intended, not a production defect. Downgraded to info so
    // it stays visible without failing anyone's build. Measured on axios
    // @81df7a5, where 3 of 5 localhost findings were in exactly those dirs.
    // Benchmark and perf harnesses belong here for the same reason tests and
    // examples do: `http://localhost:3000` in `benchmarks/http-server/` is
    // the harness pointing at the server it is measuring, not a production
    // URL that leaked. Measured on honojs/hono — 12 of its 17 blocking
    // localhost findings were under `benchmarks/`, and 3 more under
    // `runtime-tests/`. Scope, not severity: these stay visible at info.
    const isTestFile = this._isTestPath(rel) || isNonUserFacingPage(rel);
    const lines = content.split(/\r?\n/);
    const masked = this._maskedLines(content);
    let issues = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];      // raw: the URL text, messages, comment markers
      const code = masked[i] || ''; // masked: every structural match
      // A blank masked line is a comment, or the inside of a template literal
      // spanning lines — the URL check below tells them apart, so no skip here.

      // Suppressor comment on same or previous line — a comment, so raw.
      const prevLine = i > 0 ? lines[i - 1] : '';
      if (/\bhardcoded-url-ok\b/.test(line) || /\bhardcoded-url-ok\b/.test(prevLine)) continue;

      // Skip lines whose identifier context says "dev URL". Raw on purpose:
      // measured behaviour also honours a `// DEV only` annotation and a
      // `/MOCK/` path inside the string, and the corpus has not been run on
      // the narrower reading.
      if (DEV_CONTEXT_LINE_RE.test(line)) continue;

      // Skip lines under a dev-guard on the current or last 3 lines. Raw:
      // the guard IS a string comparison (`!== 'production'`).
      const guardWindow = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      if (DEV_GUARD_RE.test(guardWindow)) continue;

      // Reset regex state.
      URL_RE.lastIndex = 0;
      let m;
      while ((m = URL_RE.exec(line)) !== null) {
        // A URL is by definition string content: it counts only inside a
        // string or template literal — not a comment, not a regex. One
        // definition (src/core/source-strip.js literalKindAt).
        if (literalKindAt(lines, masked, i, m.index) !== 'string') continue;

        const scheme = m[1].toLowerCase();
        const host = m[2];
        const hostNoPort = host.split(':')[0].toLowerCase();

        // Doc-example URLs are fine.
        if (DOC_ALLOWLIST.has(hostNoPort)) continue;

        // URL used inside a string-matching call (`.startsWith(`,
        // `.endsWith(`, `.includes(`, `.indexOf(`, `.match(`, `new RegExp(`,
        // or comparison operators `=== "http..."`) is a filter pattern,
        // not a fetch target.
        const before = code.slice(Math.max(0, m.index - 40), m.index);
        if (/\.(?:startsWith|endsWith|includes|indexOf|lastIndexOf|match|search|test|split|replace|replaceAll)\s*\(\s*['"`]$/.test(before)) continue;
        if (/new\s+RegExp\s*\(\s*['"`]$/.test(before)) continue;
        if (/(?:===|!==|==|!=)\s*['"`]$/.test(before)) continue;

        // Env-fallback: `process.env.X || "http://localhost..."` is
        // explicitly the "use env in prod, localhost in dev" pattern.
        if (/\bprocess\.env\.[A-Z_][A-Z0-9_]*\s*(?:\|\||\?\?)\s*['"`]$/.test(before)) continue;
        const windowBefore = `${masked.slice(Math.max(0, i - 3), i).join('\n')}\n${code.slice(0, m.index)}`;
        if (ENV_TERNARY_RE.test(windowBefore)) continue;
        if (SCHEMA_DEFAULT_RE.test(before)) continue;
        if (LISTEN_RE.test(windowBefore)) continue;
        if (BARE_LOCALHOST_RE.test(line.slice(m.index)) && isUrlParseBase(line, before, masked.join('\n'))) continue;

        if (LOCALHOST_RE.test(host)) {
          issues += this._flag(result, `hardcoded-url:localhost:${rel}:${i + 1}`, {
            severity: isTestFile ? 'info' : 'error',
            file: rel,
            line: i + 1,
            host,
            kind: 'localhost',
            message: isTestFile
              ? `${rel}:${i + 1} hardcoded \`${scheme}://${host}\` in a test file — a fixture, not a leak; reported so the address is on record`
              : `${rel}:${i + 1} hardcoded \`${scheme}://${host}\` in source — localhost leaks break every non-developer machine the moment this ships`,
            suggestion: isTestFile
              ? 'Nothing to change unless the test is meant to reach a real service — then read the address from an env var so CI can point it elsewhere.'
              : 'Move the URL to a config file / env var (`process.env.API_BASE_URL`) with a documented default for local development. Guard any local-only fallback with `NODE_ENV !== "production"`.',
          });
          continue;
        }

        if (PRIVATE_IP_RE.test(host)) {
          issues += this._flag(result, `hardcoded-url:private-ip:${rel}:${i + 1}`, {
            severity: isTestFile ? 'info' : 'error',
            file: rel,
            line: i + 1,
            host,
            kind: 'private-ip',
            // Same three-way wording as localhost above: the address in a test
            // is a fixture on record, not a LAN address that escaped — the
            // scanner's own code-scanning alerts on tests/ssrf.test.js said
            // "escaped into committed code" about 169.254.169.254, which is
            // link-local, not RFC1918, and is the test's subject (2026-09-05).
            message: isTestFile
              ? `${rel}:${i + 1} hardcoded private / link-local URL \`${scheme}://${host}\` in a test file — a fixture, not a leak; reported so the address is on record`
              : `${rel}:${i + 1} hardcoded private / link-local URL \`${scheme}://${host}\` (RFC1918, 169.254/16 or loopback) — a developer's LAN address escaped into committed code`,
            suggestion: isTestFile
              ? 'Nothing to change unless the test really targets a live private host — then read the address from an env var.'
              : 'Replace with a public hostname, a config/env var, or a service-discovery lookup. Never commit raw private IPs.',
          });
          continue;
        }

        if (INTERNAL_TLD_RE.test(host) || STAGING_HOST_RE.test(host)) {
          issues += this._flag(result, `hardcoded-url:internal-tld:${rel}:${i + 1}`, {
            severity: isTestFile ? 'info' : 'warning',
            file: rel,
            line: i + 1,
            host,
            kind: 'internal-tld',
            message: isTestFile
              ? `${rel}:${i + 1} hardcoded internal/staging URL \`${scheme}://${host}\` in a test file — a fixture, not a leak; reported so the address is on record`
              : `${rel}:${i + 1} hardcoded internal/staging URL \`${scheme}://${host}\` — \`.internal\`/\`.local\`/staging subdomains won't resolve for external users`,
            suggestion: isTestFile
              ? 'Nothing to change unless the test really targets that host — then read it from an env var.'
              : 'Move the host to environment-specific config. Use env-driven base URLs so prod targets prod, staging targets staging, without code changes.',
          });
          continue;
        }

        // Non-TLS external URL in production code.
        if (scheme === 'http' && !isTestFile) {
          issues += this._flag(result, `hardcoded-url:insecure-scheme:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            host,
            kind: 'insecure-scheme',
            message: `${rel}:${i + 1} hardcoded non-TLS \`http://${host}\` URL — downgrade/MITM risk, mixed-content in browsers, blocked by strict CSP`,
            suggestion: 'Use `https://`. If the target only serves HTTP (unlikely in 2026), wrap it in an HTTPS proxy or document the exception via a `// allow-http:` comment on the preceding line.',
          });
        }
      }
    }

    return issues;
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = HardcodedUrlModule;
