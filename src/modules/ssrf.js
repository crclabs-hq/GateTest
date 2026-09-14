/**
 * SSRF / URL-Validation-Gap Module — user-controlled URLs in HTTP calls.
 *
 * SSRF (Server-Side Request Forgery) is OWASP A10:2021. The classic
 * bug: a server accepts a URL from the client and fetches it, letting
 * the attacker pivot to internal services (cloud metadata at
 * 169.254.169.254, RFC1918 ranges, localhost admin panels, Redis on
 * 6379, the Docker socket). Capital One's 2019 $190M breach was SSRF.
 *
 * Competitors: Semgrep has narrow per-language rules. Snyk flags the
 * function signature, not the call site. SonarQube has one Java rule
 * that misses every Node codebase. Nothing unified for JS/TS.
 *
 * Approach (line-heuristic, string-aware, no AST):
 *
 *   1. Walk JS/TS sources (skip tests).
 *   2. Track the current function's "tainted" variables — assignments
 *      from request-body/query/params/headers or webhook event bodies.
 *   3. Find HTTP client call sites (fetch/axios/got/http.request/
 *      needle/superagent/request/undici.request/ky).
 *   4. For each call, inspect the first argument (or `url:` option):
 *        - Direct reference to `req.body.*`/`req.query.*`/`req.params.*`
 *          /`ctx.request.*`/`event.body` → error (direct SSRF)
 *        - Reference to a tainted variable defined earlier in the
 *          function with no validation call between → error (tainted)
 *        - String contains a hardcoded metadata-service IP
 *          (169.254.169.254, metadata.google.internal,
 *          100.100.100.200, metadata.azure.com) → error
 *        - Reference to a user-shaped variable (`userUrl`, `targetUrl`,
 *          `webhookUrl`, `callbackUrl`, `imageUrl`, `redirectUrl`)
 *          with no visible validation → warning
 *   5. Validation shapes that suppress findings:
 *        - `validateUrl(x)` / `isValidUrl(x)` / `assertSafeUrl(x)`
 *        - `allowedHosts.includes(...)` / `ALLOWLIST.has(...)` on same var
 *        - `new URL(x).hostname` being checked against a set
 *        - `ssrf-req-filter` / `ssrf-filter` / `request-filtering-agent`
 *          / `safe-url` / `ssrfcheck` import anywhere in the file
 *        - `URL.canParse` guard + host check
 *
 * Rules:
 *
 *   error:   HTTP client call with a URL argument that is (or was
 *            assigned from) a request-body/query/params/headers field
 *            with no visible validation between assignment and call.
 *            (rule: `ssrf:tainted-url:<rel>:<line>`)
 *
 *   error:   HTTP client call to a hardcoded metadata-service endpoint
 *            (AWS/GCP/Azure/Alibaba) outside a test file. Usually a
 *            leaked internal exploit or a forgotten debug call.
 *            (rule: `ssrf:metadata-endpoint:<rel>:<line>`)
 *
 *   warning: HTTP client call whose URL argument is a variable with a
 *            user-input-shaped name (`userUrl`, `webhookUrl`,
 *            `callbackUrl`, `targetUrl`, `redirectUrl`, `imageUrl`,
 *            `sourceUrl`, `remoteUrl`) with no visible validation in
 *            the preceding window.
 *            (rule: `ssrf:unvalidated-url-var:<rel>:<line>`)
 *
 *   info:    File imports an SSRF-filtering library
 *            (`ssrf-req-filter`, `request-filtering-agent`, etc.) —
 *            recorded for dashboard confidence.
 *            (rule: `ssrf:library-ok:<rel>:<line>`)
 *
 * TODO(gluecron): host-neutral — pure source scan.
 */

const fs = require('fs');
const { repoRelative } = require('../core/repo-path');
const BaseModule = require('./base-module');

const SOURCE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);


// Every deciding regex runs on the MASKED line (BaseModule._maskedLines:
// string, regex and comment content blanked, offsets preserved). The raw
// line is read only where the rule needs what is INSIDE the quotes — the
// URL argument of the HTTP call, for the metadata-endpoint rule.
// HTTP client call entrypoints. Matches the call and we extract the
// first argument from the line / next few lines.
const HTTP_CLIENT_RES = [
  /\bfetch\s*\(/,
  /\baxios\s*\(/,
  /\baxios\.(?:get|post|put|patch|delete|head|options|request)\s*\(/,
  /\bgot\s*\(/,
  /\bgot\.(?:get|post|put|patch|delete|head)\s*\(/,
  /\bhttp\.(?:get|request)\s*\(/,
  /\bhttps\.(?:get|request)\s*\(/,
  /\bneedle\s*\(/,
  /\bneedle\.(?:get|post|put|delete|head)\s*\(/,
  /\bsuperagent\.(?:get|post|put|delete|head)\s*\(/,
  /\brequest\s*\(/,
  /\brequest\.(?:get|post|put|delete|head)\s*\(/,
  /\bundici\.(?:request|fetch)\s*\(/,
  /\bky\s*\(/,
  /\bky\.(?:get|post|put|patch|delete|head)\s*\(/,
];

// Request-body / query / params / header taint sources.
// Inline taint patterns that are OK to flag even without tracking.
const INLINE_TAINT_RE = /\b(?:req|request|ctx|event)\.(?:body|query|params|headers)[.[][\w$'"[\]]+/;

// Known cloud / container metadata endpoints — baked-in SSRF exploits.
const METADATA_ENDPOINT_RE = /\b(?:169\.254\.169\.254|100\.100\.100\.200|fd00:ec2::254|metadata\.google\.internal|metadata\.azure\.com|metadata\.goog)\b/i;

// Variable names that strongly suggest user-controlled URL.
const SUSPICIOUS_VAR_RE = /\b(?:user|target|callback|webhook|redirect|image|source|remote|import|proxy|forward|destination|external|fetch|third[Pp]arty)(?:Url|URL|Uri|URI|Endpoint|Host)\b/;

// Validation-call shapes that suppress findings when present in the
// window between the taint assignment and the HTTP call.
const VALIDATION_RE = /\b(?:validateUrl|isValidUrl|assertSafeUrl|checkUrl|isSafeUrl|sanitizeUrl|allowedHosts?|ALLOW_?LIST|HOST_?ALLOW|safeUrl|isAllowedHost|validateHost|\.hostname\s*(?:===|!==|==|!=|in\b)|SSRF_?FILTER)/;

// SSRF-filter library imports anywhere in the file → library-ok.
const SSRF_LIB_RE = /(?:require\s*\(\s*['"]|from\s+['"])(?:ssrf-req-filter|ssrf-filter|request-filtering-agent|safe-url|ssrfcheck|@[^/]+\/ssrf[^'"]*)['"]/;

class SSRFModule extends BaseModule {
  constructor() {
    super(
      'ssrf',
      'SSRF / URL-validation gap detector — user-controlled URLs handed to fetch/axios/got/node-http without validation',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findFiles(projectRoot);

    if (files.length === 0) {
      result.addCheck('ssrf:no-files', true, {
        severity: 'info',
        message: 'No JS/TS source files found — skipping',
      });
      return;
    }

    result.addCheck('ssrf:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} JS/TS file(s) for SSRF / URL-validation gaps`,
    });

    let issues = 0;
    for (const file of files) {
      issues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('ssrf:summary', true, {
      severity: 'info',
      message: `SSRF scan: ${files.length} file(s), ${issues} issue(s)`,
    });
  }

  // KI #104: the shared walk replaces a private readdir copy so `--diff` /
  // `--pr` scans only touch changed files. `.terraform` is the one exclude
  // not in the shared defaults.
  _findFiles(projectRoot) {
    return this._collectFiles(projectRoot, [...SOURCE_EXTS], ['.terraform']);
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return 0; }

    const rel = repoRelative(projectRoot, file);
    const isTestFile = this._isTestPath(rel);
    const lines = content.split(/\r?\n/);
    const masked = this._maskedLines(content);
    let issues = 0;

    // Library-ok short-circuit: if the file imports an SSRF-filter,
    // we record info and still scan (library presence ≠ usage on every
    // call site) but we'll downgrade the hardcoded-metadata rule since
    // the codebase is clearly aware.
    const hasSsrfLib = SSRF_LIB_RE.test(content);
    if (hasSsrfLib) {
      issues += this._flag(result, `ssrf:library-ok:${rel}`, {
        severity: 'info',
        file: rel,
        message: `${rel} imports an SSRF-filter library — good`,
      });
    }

    // Taint map: `varName` → line number of last assignment from a
    // request body/query/params/headers source (within current function).
    // We approximate "current function" by resetting the map on lines
    // that look like function boundaries (`function` / `=>` new blocks
    // at column 0-ish, class methods, arrow function start).
    const taintedVars = new Map();

    for (let i = 0; i < lines.length; i += 1) {
      const code = masked[i] || '';
      if (!code.trim()) continue;

      // Rough "function boundary" reset.
      if (/^\s*(?:async\s+)?function\b|^\s*\w+\s*\([^)]*\)\s*\{|^\s*(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:function|\()|^}$/.test(code)) {
        // A new function scope could start; we clear prior taint
        // assignments to stop cross-function leak.
        // (Keep the map but prune old entries — simple: clear.)
        taintedVars.clear();
      }

      // --- Track taint assignments ---
      // `const x = req.body.url;` / `let x = req.query.target;` / etc.
      const taintAssign = code.match(
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*?\b(?:req|request|ctx|event)\.(?:body|query|params|headers|rawBody)\b/,
      );
      if (taintAssign) {
        taintedVars.set(taintAssign[1], i);
      }
      // Destructured: `const { url } = req.body;` → treat `url` as tainted
      const destruct = code.match(
        /\b(?:const|let|var)\s*\{\s*([^}]+)\}\s*=\s*[^;]*?\b(?:req|request|ctx|event)\.(?:body|query|params|headers)\b/,
      );
      if (destruct) {
        for (const name of destruct[1].split(',')) {
          const clean = name.trim().split(/[:=\s]/)[0];
          if (clean && /^[A-Za-z_$][\w$]*$/.test(clean)) taintedVars.set(clean, i);
        }
      }

      // --- Validation call clears taint on referenced vars ---
      if (VALIDATION_RE.test(code)) {
        // crude: any identifier passed to a validator gets untainted
        const valArgs = code.match(/\b(?:validateUrl|isValidUrl|assertSafeUrl|checkUrl|isSafeUrl|sanitizeUrl)\s*\(\s*([A-Za-z_$][\w$]*)/);
        if (valArgs) taintedVars.delete(valArgs[1]);
      }

      // --- HTTP client call site ---
      let httpMatch = null;
      for (const re of HTTP_CLIENT_RES) {
        const m = code.match(re);
        if (m) { httpMatch = m; break; }
      }
      if (!httpMatch) continue;

      // Pull the first argument: text from after '(' to matching ')' or
      // first ',' at depth 0, on this line + up to 3 continuation lines.
      // Brackets and commas are counted on the masked text; `argText` is
      // the raw argument (its URL literal intact), `argCode` the masked one.
      const argStart = httpMatch.index + httpMatch[0].length;
      const { argText, argCode } = this._extractFirstArg(masked, lines, i, argStart);
      if (!argText) continue;

      // Metadata endpoint hardcoded.
      if (METADATA_ENDPOINT_RE.test(argText)) {
        issues += this._flag(result, `ssrf:metadata-endpoint:${rel}:${i + 1}`, {
          severity: isTestFile ? 'info' : 'error',
          file: rel,
          line: i + 1,
          kind: 'metadata-endpoint',
          message: `${rel}:${i + 1} HTTP call to cloud-metadata endpoint — SSRF exploit pattern (AWS 169.254.169.254 / GCP metadata.google.internal / Azure metadata.azure.com / Alibaba 100.100.100.200)`,
          suggestion: 'Remove the metadata-service call, or if it is legitimate (pulling IAM creds inside the node), route it through an IMDSv2 client that requires a session token and is NOT reachable from user-supplied URLs.',
        });
        continue;
      }

      // Direct inline taint: `fetch(req.body.url)` / `fetch(req.query.x)`
      if (INLINE_TAINT_RE.test(argCode)) {
        // Suppress if a validation call is in scope (same line or
        // preceding 5 lines referencing the argument).
        const windowTxt = masked.slice(Math.max(0, i - 5), i + 1).join('\n');
        if (VALIDATION_RE.test(windowTxt)) continue;
        issues += this._flag(result, `ssrf:tainted-url:${rel}:${i + 1}`, {
          severity: isTestFile ? 'info' : 'error',
          file: rel,
          line: i + 1,
          kind: 'tainted-url',
          message: `${rel}:${i + 1} HTTP call handed a URL directly from user input (\`req.body\`/\`req.query\`/\`req.params\`/\`req.headers\`) with no visible validation — classic SSRF (OWASP A10)`,
          suggestion: 'Parse the URL with `new URL(input)`, then enforce an allowlist of hostnames and protocols (only `https:` to approved hosts). Reject private/link-local ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fd00::/8). Or use `ssrf-req-filter` / `request-filtering-agent` for agent-level protection.',
        });
        continue;
      }

      // Tainted variable reference: the argument's first identifier
      // is in the taint map AND no validator ran in between.
      const firstIdent = argCode.match(/^[\s(]*([A-Za-z_$][\w$]*)\b/);
      if (firstIdent && taintedVars.has(firstIdent[1])) {
        const taintLine = taintedVars.get(firstIdent[1]);
        const windowTxt = masked.slice(taintLine, i + 1).join('\n');
        if (VALIDATION_RE.test(windowTxt)) {
          taintedVars.delete(firstIdent[1]);
          continue;
        }
        issues += this._flag(result, `ssrf:tainted-url:${rel}:${i + 1}`, {
          severity: isTestFile ? 'info' : 'error',
          file: rel,
          line: i + 1,
          variable: firstIdent[1],
          kind: 'tainted-url',
          message: `${rel}:${i + 1} HTTP call uses \`${firstIdent[1]}\` which was assigned from user input on line ${taintLine + 1} — SSRF (OWASP A10)`,
          suggestion: `Before the HTTP call, validate \`${firstIdent[1]}\`: parse as URL, enforce hostname allowlist, reject private ranges. Or pipe the request through an SSRF filter agent.`,
        });
        continue;
      }

      // Suspicious-named variable with no validation.
      const susVar = argCode.match(SUSPICIOUS_VAR_RE);
      if (susVar && !isTestFile) {
        // Look back 10 lines for a validator call on this var or
        // nearby.
        const windowTxt = masked.slice(Math.max(0, i - 10), i + 1).join('\n');
        if (VALIDATION_RE.test(windowTxt)) continue;
        issues += this._flag(result, `ssrf:unvalidated-url-var:${rel}:${i + 1}`, {
          severity: 'warning',
          file: rel,
          line: i + 1,
          variable: susVar[0],
          kind: 'unvalidated-url-var',
          message: `${rel}:${i + 1} HTTP call uses variable \`${susVar[0]}\` whose name suggests user-controlled URL, with no visible validation — possible SSRF`,
          suggestion: `Validate \`${susVar[0]}\` against a hostname allowlist before the HTTP call, or route through an SSRF-filtering agent.`,
        });
      }
    }

    return issues;
  }

  _extractFirstArg(masked, lines, startLine, startCol) {
    // Walk forward from startCol collecting characters until the
    // matching top-level `)` or a top-level `,`. Accumulate up to 4
    // lines total (usually plenty — objects and multi-line calls).
    // Depth is counted on the masked text — a `,` or `)` inside a string
    // is not a boundary — while both the raw and the masked argument are
    // collected at the same offsets.
    let depth = 1; // we start right after the opening `(`
    let argText = '';
    let argCode = '';
    const maxLines = 4;
    const done = () => ({ argText: argText.trim(), argCode: argCode.trim() });
    for (let li = 0; li < maxLines; li += 1) {
      const ln = lines[startLine + li];
      const mk = masked[startLine + li] || '';
      if (ln == null) break;
      const from = li === 0 ? startCol : 0;
      for (let j = from; j < ln.length; j += 1) {
        const ch = mk[j];
        if (ch === '(' || ch === '[' || ch === '{') depth += 1;
        else if (ch === ')' || ch === ']' || ch === '}') {
          depth -= 1;
          if (depth === 0) return done();
        } else if (ch === ',' && depth === 1) {
          return done();
        }
        argText += ln[j];
        argCode += ch;
      }
      argText += ' ';
      argCode += ' ';
    }
    return done();
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = SSRFModule;
