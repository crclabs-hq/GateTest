/**
 * Security Module - Comprehensive security scanning.
 * Checks headers, dependencies, OWASP patterns, CSP, CORS, and more.
 */

const BaseModule = require('./base-module');
const { JS_SOURCE_EXTS } = require('../core/source-extensions');
const { innerHtmlAssignmentIsSafe, splitTopLevel } = require('../core/inner-html-safety');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// SQL injection via string concatenation or template-literal interpolation
// of an identifier into a SQL string, built or used at a query-like sink
// (.query(/.execute(/.raw(/db.run(...). Parameterised calls (placeholder
// `?`/`$1` + a values array) and tagged-template query builders (sql`...`,
// Prisma.sql`...`, db.sql`...`) auto-escape every interpolation and must
// NOT fire — enforced by requiring a literal `+`/`${}` splice directly
// inside the SQL string, and by excluding any backtick immediately
// preceded by a tag identifier (the tag-function shape of every SQL
// template-tag library).
const SQL_KEYWORDS = 'SELECT|INSERT|UPDATE|DELETE|CREATE|DROP';
const SQL_CONCAT_RE = new RegExp(`(['"])(?:${SQL_KEYWORDS})\\b(?:(?!\\1).)*\\1\\s*\\+\\s*[A-Za-z_$][\\w.$]*`, 'i');
const SQL_TEMPLATE_RE = new RegExp('(?<![\\w$])`(?:' + SQL_KEYWORDS + ')\\b(?:(?!`).)*\\$\\{[^}]+\\}(?:(?!`).)*`', 'i');
const SQL_SINK_RE = /\.\s*(?:query|execute|raw|run|all)\s*\(/;
const SQL_ASSIGN_RE = /^\s*(?:const|let|var)\s+(\w+)\s*=/;
const SQL_INJECTION_LOOKAHEAD = 15;

// ---------------------------------------------------------------------------
// Variable expansions are references, not committed credentials.
//
// docker-compose.yml carried
//     DATABASE_URL: postgresql://${POSTGRES_USER:-gatetest}:${POSTGRES_PASSWORD:-gatetest}@postgres:5432/…
// and the connection-string rule reported it as a hardcoded credential —
// twice, blocking the gate. There is no secret on that line: every credential
// component is a `${VAR:-default}` expansion. Commit ac138e92 had already
// tried to fix this by switching to that very syntax ("breaks the
// credential-URL regex", it said) — it did not, because the existing
// placeholder allow-list only recognises the bare `${VAR}` form. A mitigation
// that was never measured.
//
// The masks are LENGTH-PRESERVING so `match.index` still addresses the real
// line, and masking is applied to the line rather than skipping it, so a
// literal secret that merely shares a line with an expansion still fires.
// The final `\$NAME` alternative carries `\b(?!\s*=)` so it masks a bare
// expansion USED as a value (`DB_URL=$SECRET`, `redis://$USER:$PASS@h`) but
// not an identifier being ASSIGNED to (`$apiKey = "…"` — a `$`-prefixed
// variable name is a JS/Svelte convention, and masking it would hide the
// keyword the generic key/password rules match on).
//
// The `\b` is load-bearing, not decoration. With `(?!\s*=)` alone the engine
// simply backtracks: `$apiKey` fails the lookahead, so it retries `$apiKe`,
// which is followed by `y` and passes — masking six of the seven characters
// and hiding the keyword anyway. `\b` forces a whole identifier, so the
// alternative either matches all of it or none of it.
const INTERPOLATION_RE = /\$\{[^}\n]*\}|\{\{[^}\n]*\}\}|\$\([^)\n]*\)|%[A-Za-z_][A-Za-z0-9_]*%|\$[A-Za-z_][A-Za-z0-9_]*\b(?!\s*=)/g;
// U+0001 is not in any secret pattern's value character class, so a masked
// expansion cannot itself look like a key, token or quoted password. Only the
// connection-string rule's `[^:\s]+`/`[^@\s]+` userinfo classes admit it, and
// `credentialIsFullyExpanded` handles that case.
const INTERPOLATION_MASK = '\u0001';

function maskInterpolations(line) {
  return line.replace(INTERPOLATION_RE, (m) => INTERPOLATION_MASK.repeat(m.length));
}

/**
 * True when a matched `scheme://user:pass@host` has NOTHING literal in the
 * password position — i.e. the password is entirely a masked expansion.
 *
 * `postgresql://${U}:${P}@host`  → expanded, not a secret.
 * `postgresql://${U}:hunter2@host` → password is literal, still a secret.
 */
function credentialIsFullyExpanded(matchedText) {
  const schemeEnd = matchedText.indexOf('://');
  if (schemeEnd === -1) return false;
  // Userinfo cannot contain `@` (the pattern's own class forbids it), so the
  // FIRST `@` is the boundary — `lastIndexOf` would over-reach into a path.
  const at = matchedText.indexOf('@', schemeEnd + 3);
  if (at === -1) return false;
  const userinfo = matchedText.slice(schemeEnd + 3, at);
  const colon = userinfo.lastIndexOf(':');
  if (colon === -1) return false;
  const password = userinfo.slice(colon + 1);
  return password.length > 0 && !password.split('').some((c) => c !== INTERPOLATION_MASK);
}

class SecurityModule extends BaseModule {
  constructor() {
    super('security', 'Security Analysis');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    // Dependency vulnerability scan
    this._checkDependencies(projectRoot, result);

    // Source code security patterns (OWASP Top 10)
    this._checkSourcePatterns(projectRoot, result);

    // SQL injection via string concatenation / template interpolation
    this._checkSqlInjectionPatterns(projectRoot, result);

    // MD5/SHA-1 used to hash a credential
    this._checkWeakPasswordHashing(projectRoot, result);

    // Prototype pollution — user-controlled key in a bracket assignment
    this._checkPrototypePollution(projectRoot, result);

    // Path traversal — user-controlled path into a filesystem call
    this._checkPathTraversal(projectRoot, result);

    // Check for dangerous file permissions
    this._checkFilePermissions(projectRoot, result);

    // Check package.json for suspicious scripts
    this._checkPackageScripts(projectRoot, result);

    // Check for .npmrc with auth tokens
    this._checkNpmAuth(projectRoot, result);

    // Scan for hardcoded secrets, API keys, tokens, and passwords
    this._scanForSecrets(projectRoot, result);

    // Docker security
    this._checkDockerSecurity(projectRoot, result);

    // .gitignore validation — sensitive files must be ignored
    this._checkGitignore(projectRoot, result);

    // Dependency license compliance
    this._checkLicenseCompliance(projectRoot, result);

    // Environment file security
    this._checkEnvFiles(projectRoot, result);

    // Live security headers validation
    await this._checkSecurityHeaders(config, result);
  }

  _checkDependencies(projectRoot, result) {
    const pkgPath = path.join(projectRoot, 'package.json');

    if (!fs.existsSync(pkgPath)) {
      result.addCheck('security:dependencies', true, { message: 'No package.json — skipping dep scan' });
      return;
    }

    const { exitCode, stdout } = this._exec('npm audit --json', { cwd: projectRoot, timeout: 120000 });

    if (exitCode === 0) {
      result.addCheck('security:npm-audit', true, { message: 'No known vulnerabilities' });
    } else {
      try {
        const audit = JSON.parse(stdout);
        const vulns = audit.metadata?.vulnerabilities || {};
        const critical = vulns.critical || 0;
        const high = vulns.high || 0;
        const moderate = vulns.moderate || 0;

        // Reachability-gated (src/core/dependency-reachability.js): only a
        // critical/high advisory in a PRODUCTION dependency that source code
        // actually IMPORTS blocks. Dev-only tooling and installed-but-unused
        // packages are reported with the reason, never as a red X — the
        // Dependabot/Snyk "noise machine" complaint is exactly those.
        let analysis = null;
        try {
          analysis = require('../core/dependency-reachability').analyseProject(audit, projectRoot);
        } catch (err) { // error-ok — reachability is a refinement; fall back to raw counts below
          console.error('[security] dependency reachability failed:', err && err.message ? err.message : err);
        }
        if (analysis && analysis.items.length > 0) {
          const { gateSeverity } = require('../core/dependency-reachability');
          const reachableHigh = analysis.items.filter((i) => i.class === 'reachable' && (i.severity === 'critical' || i.severity === 'high'));
          const c = analysis.counts;
          for (const item of analysis.items) {
            const sev = gateSeverity(item);
            if (sev === 'info' && !(item.severity === 'critical' || item.severity === 'high')) continue; // low/moderate dev-only: summary only
            result.addCheck(`security:npm-audit:${item.name}`, false, {
              severity: sev,
              file: 'package.json',
              message: `${item.severity} advisory in ${item.name}${item.range ? ` (${item.range})` : ''} — ${item.reason}`,
              suggestion: item.fixAvailable ? `Run "npm audit fix" (a non-breaking fix is available for ${item.name})` : `Upgrade or replace ${item.name}; no automatic fix is available`,
              reachability: item.class,
            });
          }
          if (reachableHigh.length > 0) {
            result.addCheck('security:npm-audit', false, {
              message: `${reachableHigh.length} reachable critical/high advisor${reachableHigh.length === 1 ? 'y' : 'ies'} (${reachableHigh.map((i) => i.name).join(', ')}) — plus ${c['installed-unused']} installed-but-unused and ${c['dev-only']} dev-only advisories that do not block`,
              suggestion: 'Fix the reachable ones first: they are imported by production code.',
            });
          } else {
            result.addCheck('security:npm-audit', true, {
              severity: 'info',
              message: `No reachable critical/high advisories. ${critical + high} critical/high advisor${critical + high === 1 ? 'y' : 'ies'} exist in dev-only (${c['dev-only']}) or installed-but-unused (${c['installed-unused']}) packages — shown above, not blocking. ${moderate} moderate.`,
            });
          }
        } else if (critical > 0 || high > 0) {
          result.addCheck('security:npm-audit', false, {
            message: `${critical} critical, ${high} high, ${moderate} moderate vulnerabilities`,
            suggestion: 'Run "npm audit fix" or update vulnerable packages',
          });
        } else {
          result.addCheck('security:npm-audit', true, {
            message: `No critical/high vulnerabilities (${moderate} moderate)`,
          });
        }
      } catch {
        // "The tool could not run here" (no lockfile, offline, registry
        // down) is a fact about the scan environment, not a vulnerability
        // in the customer's code. Info, never a blocking error — this was
        // a gate failure on 4 of 9 real repos in the 2026-08-18 audit.
        result.addCheck('security:npm-audit', true, {
          severity: 'info',
          message: 'npm audit could not run in this environment (no lockfile, offline, or registry unreachable) — dependency vulnerabilities were not checked here',
          suggestion: 'Run "npm audit" manually or in CI to check for vulnerabilities',
        });
      }
    }
  }

  /**
   * Both delegate to src/core/inner-html-safety.js.
   *
   * These were implemented here first, then codeQuality's forbidden-pattern
   * list turned out to carry a SECOND innerHTML rule with the same false
   * positive — so guarding this one alone still failed the gate on escaped
   * output. The predicate now has one home and both rules import it. Kept as
   * thin methods so existing callers and tests keep working.
   */
  _splitTopLevel(expr, sep) {
    return splitTopLevel(expr, sep);
  }

  _innerHtmlAssignmentIsSafe(line) {
    return innerHtmlAssignmentIsSafe(line);
  }

  _checkSourcePatterns(projectRoot, result) {
    const files = this._collectFiles(projectRoot, JS_SOURCE_EXTS);
    const dangerousPatterns = [
      // `eval` must be its own identifier, not the tail of a longer one.
      // Without the lookbehind, Playwright's `page.$$eval(...)` / `$eval(...)`
      // — a static arrow function serialised into the page, no dynamic code
      // anywhere — reported as CRITICAL eval(), 3 blocking errors on a single
      // ops script (2026-08-31 self-scan). `$` is in the class because that is
      // the character the Playwright locator APIs put immediately before
      // `eval`; `\w` covers `myeval(` / `_eval(`.
      //
      // A leading `.` is deliberately NOT excluded, so genuine indirect calls
      // (`window.eval(...)`, `globalThis.eval(...)`) still fire.
      { regex: /(?<![\w$])eval\s*\(/g, name: 'eval()', severity: 'critical' },
      { regex: /new\s+Function\s*\(/g, name: 'Function constructor', severity: 'critical' },
      // Fires on the SINK, then clears the ones that provably cannot inject.
      // As a bare `.innerHTML =` match this reported `el.innerHTML = ''`
      // (clearing a node) and `innerHTML = "<b>" + escapeHtml(x) + "</b>"`
      // as blocking errors — correctly-escaped code failing the gate, which
      // is the worst kind of finding (Forbidden #25: painkiller, not
      // bottleneck). Measured 2026-09-01 against a positive/negative control
      // pair: 1 of 2 findings was a false positive on escaped output.
      //
      // safeIf only clears an assignment whose EVERY dynamic segment is
      // wrapped in a recognised escaper — `escapeHtml(a) + b` still fires,
      // because `b` is unescaped. A static literal cannot carry user input
      // at all. Everything else still reports.
      {
        regex: /\.innerHTML\s*=(?!=)/g,
        name: 'innerHTML assignment',
        severity: 'high',
        safeIf: (line) => this._innerHtmlAssignmentIsSafe(line),
      },
      { regex: /document\.write\s*\(/g, name: 'document.write()', severity: 'high' },
      { regex: /child_process.*exec\s*\(/g, name: 'shell exec without sanitization', severity: 'high' },
      // The rule above requires `child_process` on the SAME LINE, so it only
      // ever caught `require('child_process').exec(...)` written inline. The
      // ordinary shape —
      //     const cp = require('child_process');
      //     cp.execSync('ls ' + req.query.dir);
      // — was invisible, i.e. command injection, the OWASP staple, went
      // undetected in its most common form. Found 2026-07-28 by scanning a
      // fixture of genuinely-vulnerable code to measure false NEGATIVES.
      //
      // Deliberately scoped to exec/execSync, which run their argument
      // through a shell. execFile/spawn take an argv array and are the SAFE
      // alternative — flagging those would punish the correct fix. Requires
      // a `+` or `${` in the argument, so a static command is not flagged.
      // The `(?!\[)` is the whole difference between a shell command and an
      // argv array. Node's `exec`/`execSync` take a command STRING and hand it
      // to a shell; neither can accept an array. So a call shaped
      //
      //     exec(["git", "show", `${ref}:${path}`], repoDir)
      //
      // is a project's own argv-style helper that merely shares the name — no
      // shell ever parses that interpolation. Reported as critical on
      // ccantynz/Gluecron.com @e168803 (gluecron.com), returned by that team
      // as our false positive with the mechanism, and they were right.
      //
      // The rule's comment below already had the principle — argv arrays are
      // the SAFE alternative — but keyed it on the callee's NAME. The safety
      // property lives in the argument's SHAPE, and a helper named `exec` that
      // takes argv is the safe form wearing the unsafe name. This class fires
      // on argv call sites across any Bun/Node codebase, so it is not niche.
      //
      // Only an array literal is excluded. `exec(cmd + input)` with no leading
      // quote still fires, because that one really can reach a shell.
      { regex: /\b(?:exec|execSync)\s*\(\s*(?!\[)[^)]*(?:\+|\$\{)/g, name: 'shell exec with interpolated input', severity: 'critical' },
      { regex: /\$\{.*req\.(params|query|body)/g, name: 'unsanitized user input in template', severity: 'critical' },
      { regex: /res\.redirect\s*\(\s*req\./g, name: 'open redirect risk', severity: 'high' },
      { regex: /\.createReadStream\s*\(\s*req\./g, name: 'path traversal risk', severity: 'critical' },
      // Math.random() is only a SECURITY finding when the value becomes a
      // token / secret / id / nonce / password / OTP / session / key. Used
      // for jitter, dates, sampling, animation or test data it is fine —
      // 10/10 sampled hits in the 2026-08-18 audit were that kind.
      { regex: /(?:token|secret|nonce|otp|password|passcode|session|salt|apiKey|api_key|csrf|verification|reset|invite|code|id|uuid|key)\w*\s*[:=]\s*[^;\n]*Math\.random\s*\(|Math\.random\s*\([^;\n]*(?:toString\(36\)|toString\(16\))[^;\n]*(?:token|secret|nonce|otp|password|session|salt|key|id)/gi, name: 'Math.random() for a security-sensitive value (use crypto.randomBytes / randomUUID)', severity: 'moderate' },
      { regex: /disable.*csrf|csrf.*disable/gi, name: 'CSRF protection disabled', severity: 'critical' },
      // NoSQL injection: a $where clause built from dynamic input executes
      // attacker-controlled JavaScript on the MongoDB server (NodeGoat A1;
      // 2026-08-18 audit advancement #6 — this class was a recall miss).
      // A STATIC $where string is not flagged.
      { regex: /\$where\s*[:=]\s*`[^`\n]*\$\{/g, name: 'NoSQL injection ($where with interpolated input)', severity: 'critical' },
      { regex: /\$where\s*[:=]\s*['"][^'"\n]*['"]\s*\+/g, name: 'NoSQL injection ($where with concatenated input)', severity: 'critical' },
      // Template auto-escaping disabled (swig/nunjucks/twig-style config):
      // every variable rendered anywhere in the app becomes an XSS sink.
      { regex: /autoescape\s*:\s*false/g, name: 'template auto-escaping disabled (XSS)', severity: 'critical' },
    ];

    // Files that LEGITIMATELY contain these patterns as STRINGS / REGEX they
    // search for in customer code — the scanner shouldn't flag itself.
    // Tests get a pass too: they intentionally construct these patterns to
    // verify the scanner detects them.
    // src/core/ — config / generator / pattern definitions
    // website/app/components/howitworks/modules-data.ts — describes modules in copy
    // website/app/for/ — marketing pages describing what we detect
    // website/app/api/admin/auth — Math.random used for INTENTIONAL jitter delay
    //                              (brute-force resistance, not crypto)
    // website/app/api/scan/* — orchestrator code that talks ABOUT eval patterns
    //                          in PR/result text, not eval() calls
    // website/app/components/LiveScanTerminal — Math.random for animation timing
    const SCANNER_PATH_RE = /(?:^|\/)(?:src\/modules|src\/core|website\/app\/lib\/scan-modules|website\/app\/components\/howitworks|website\/app\/for|website\/app\/api\/admin\/auth|website\/app\/api\/scan|website\/app\/components\/LiveScanTerminal|tests|integrations\/infra)\//;

    // Project-level middleware posture (2026-08-18 audit advancement #6:
    // helmet + CSRF were recall misses). Signals are collected from
    // COMMENT-STRIPPED content — NodeGoat's planted vulnerability is
    // exactly `app.use(helmet…)` / `app.use(csrf())` sitting inside a
    // /* block comment */, which a naive grep counts as protection.
    const posture = { express: false, sessionMw: false, mutatingRoute: false, csrf: false, helmet: false };

    for (const file of files) {
      const relPath = path.relative(projectRoot, file);
      // Normalise to forward slashes for cross-platform regex match.
      const normalisedPath = relPath.replace(/\\/g, '/');
      if (SCANNER_PATH_RE.test(normalisedPath)) continue;
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split(/\r?\n/);

      // Test files don't wire the app — and their fixtures legitimately
      // contain the keywords (a ZAP test with `_csrf` URL-encoded in a
      // payload string must not count as CSRF protection). Example/demo
      // directories are excluded in BOTH directions: a library repo whose
      // only session()+POST usage is its examples (expressjs/express) is
      // not "an app missing CSRF protection".
      if (!/(^|\/)(tests?|spec|__tests__|examples?|samples?|demos?)\//.test(normalisedPath)) {
        const live = content
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^[ \t]*\/\/[^\n]*/gm, '');
        if (/require\s*\(\s*['"]express['"]\s*\)|from\s+['"]express['"]/.test(live)) posture.express = true;
        if (/require\s*\(\s*['"](?:express-session|cookie-session)['"]\s*\)/.test(live)) posture.sessionMw = true;
        if (/\.(post|put|delete|patch)\s*\(\s*['"`]/.test(live)) posture.mutatingRoute = true;
        // Middleware SHAPES, not substrings: require of a CSRF package, a
        // csrf() mount, or a csrfToken() call in live code.
        if (/require\s*\(\s*['"](?:csurf|lusca|tiny-csrf|csrf-csrf|@fastify\/csrf-protection)['"]\s*\)|\bcsrf\s*\(\s*\)|\.csrfToken\s*\(|\bcsrfProtection\b/.test(live)) posture.csrf = true;
        if (/require\s*\(\s*['"]helmet['"]\s*\)|from\s+['"]helmet['"]/.test(live)) posture.helmet = true;
      }

      for (const pattern of dangerousPatterns) {
        for (let i = 0; i < lines.length; i++) {
          pattern.regex.lastIndex = 0;
          // Skip lines that explicitly annotate themselves as scanner patterns,
          // or that look like regex-definition lines (literal `/.../` followed
          // by a flag, sitting inside an array of pattern objects).
          //
          // This is an AUTHOR OPT-OUT MARKER, not a heuristic: it silences a
          // line only because someone deliberately typed the marker on it.
          // It still needs a control, because a future widening of the marker
          // regex would turn a deliberate escape hatch into a blanket mute,
          // and nothing else would notice.
          // suppression-control: tests/security-inert-patterns.test.js
          const line = lines[i];
          if (/gatetest-self-pattern|gatetest-pattern-ok/.test(line)) continue;
          // Prose about eval() is not a call to eval(). Without these two
          // guards this loop reported 13 BLOCKING errors on a file whose
          // every dangerous token sat inside a doc string or a comment —
          // false positives that stop the gate, which is the worst kind
          // (Bible Forbidden #25: we are the painkiller, not the bottleneck).
          if (this._isCommentLine(line)) continue;
          // exec(), not test() — `test()` advances lastIndex on these /g
          // regexes, so a following exec() would resume past the match and
          // return null. Same trap that silently disabled the secrets
          // module's placeholder allow-list (KI #78 audit).
          pattern.regex.lastIndex = 0;
          const match = pattern.regex.exec(line);
          pattern.regex.lastIndex = 0;
          if (match) {
            if (this._isInsideStringLiteral(line, match.index)) continue;
            // Per-pattern proof of safety. Distinct from the opt-out marker
            // above: that one silences a line because an author asked, this
            // one silences it because the code on it cannot do the thing the
            // rule is looking for. Controls live in
            // tests/security-innerhtml-escaping.test.js — a suppression with
            // no positive control is indistinguishable from a broken rule.
            if (pattern.safeIf && pattern.safeIf(line)) continue;
            result.addCheck(`security:${pattern.name}:${relPath}:${i + 1}`, false, {
              file: relPath,
              line: i + 1,
              // Carried so the confidence scorer can judge the exact
              // position rather than falling back to a whole-line guess.
              column: match.index,
              // Structured, not just prose in the message. Every one of
              // these is severity:'error', so without this the triage
              // shortlist ranked "Math.random() for security" (moderate)
              // above SQL injection (critical) — the first thing a new user
              // reads should be the worst thing found.
              impact: pattern.severity,
              message: `${pattern.severity.toUpperCase()}: ${pattern.name} detected`,
              suggestion: `Review and replace ${pattern.name} with a safe alternative`,
            });
          }
        }
      }
    }

    if (files.length > 0) {
      result.addCheck('security:source-scan', true, { message: `Scanned ${files.length} source files` });
    }

    // Posture findings are WARNINGS, not errors: an Express app behind a
    // header-setting proxy, or an API with token auth instead of cookies,
    // is a legitimate reason for either to be absent — surface it, don't
    // block on it (Forbidden #25).
    if (posture.express && !posture.helmet) {
      result.addCheck('security:no-helmet', false, {
        severity: 'warning',
        message: 'Express app without a security-header middleware — no active helmet require found (commented-out helmet does not count)',
        suggestion: 'npm i helmet, then `app.use(helmet())` before the routes; or set the headers at your proxy and document where.',
      });
    }
    if (posture.sessionMw && posture.mutatingRoute && !posture.csrf) {
      result.addCheck('security:no-csrf-protection', false, {
        severity: 'warning',
        message: 'Cookie-session app with state-changing routes and no CSRF protection — no active csurf/lusca/csrf reference found',
        suggestion: 'Add CSRF middleware (e.g. csurf) to every state-changing route, or move to token auth where CSRF does not apply.',
      });
    }
  }

  _checkSqlInjectionPatterns(projectRoot, result) {
    const files = this._collectFiles(projectRoot, JS_SOURCE_EXTS);
    // Same exclusion list as _checkSourcePatterns — this scanner's own
    // pattern definitions and marketing copy describing SQL injection
    // legitimately contain the shapes it's designed to detect.
    const SCANNER_PATH_RE = /(?:^|\/)(?:src\/modules|src\/core|website\/app\/lib\/scan-modules|website\/app\/components\/howitworks|website\/app\/for|website\/app\/api\/admin\/auth|website\/app\/api\/scan|website\/app\/components\/LiveScanTerminal|tests|integrations\/infra)\//;

    let totalFindings = 0;

    for (const file of files) {
      const relPath = path.relative(projectRoot, file).replace(/\\/g, '/');
      if (SCANNER_PATH_RE.test(relPath)) continue;

      let content;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = SQL_CONCAT_RE.exec(line) || SQL_TEMPLATE_RE.exec(line);
        if (!match) continue;
        if (this._isInsideStringLiteral(line, match.index)) continue;

        // Built and used at a sink on the same line — flag directly.
        if (SQL_SINK_RE.test(line)) {
          this._reportSqlInjection(result, relPath, i + 1);
          totalFindings++;
          continue;
        }

        // Built here, assigned to a variable — flag if that variable is
        // passed to a query-like sink within the next few lines.
        const assignMatch = SQL_ASSIGN_RE.exec(line);
        if (!assignMatch) continue;
        const varRe = new RegExp(`\\b${assignMatch[1]}\\b`);
        const lookahead = lines.slice(i + 1, i + 1 + SQL_INJECTION_LOOKAHEAD);
        if (lookahead.some((l) => SQL_SINK_RE.test(l) && varRe.test(l))) {
          this._reportSqlInjection(result, relPath, i + 1);
          totalFindings++;
        }
      }
    }

    const reported = this._liveFindingCount(result, 'security:sql-injection:', totalFindings);
    if (reported === 0) {
      result.addCheck('security:sql-injection-scan', true, {
        message: `Scanned ${files.length} source files for SQL injection — none found`,
      });
    } else {
      result.addCheck('security:sql-injection-scan', false, {
        message: `Found ${reported} potential SQL injection pattern(s)`,
        suggestion: 'Use parameterised queries (placeholders + a values array) or a tagged-template SQL builder instead of concatenating/interpolating identifiers into SQL text',
      });
    }
  }

  /**
   * How many findings of a family are STILL LIVE after the runner's
   * suppression passes (.gatetestignore, baseline).
   *
   * The pathless rollup checks (`security:secrets-scan`,
   * `security:sql-injection-scan`) used to report a raw in-module counter.
   * That counter includes findings the user deliberately silenced — so this
   * repo's own `.gatetestignore` entries for `reliability-corpus/**` and
   * `benchmarks/bench-target/**` (the intentional known-bad corpora) silenced
   * every per-file finding and the gate still went BLOCKED on
   * "Found 4 potential SQL injection pattern(s)" with nothing left to fix.
   * A rollup has no file path, so `.gatetestignore` cannot even target it
   * without also hiding real findings — the user had no way out. That is the
   * bottleneck failure mode of Forbidden #25.
   *
   * `fallback` is used when the caller passes a bare result stub (unit tests
   * build one with no suppression machinery), so behaviour is unchanged there.
   */
  _liveFindingCount(result, prefix, fallback) {
    if (!result || !Array.isArray(result.checks)) return fallback;
    return result.checks.filter(
      (c) => c && c.passed === false && !c.suppressed
        && typeof c.name === 'string' && c.name.startsWith(prefix),
    ).length;
  }

  _reportSqlInjection(result, relPath, lineNo) {
    result.addCheck(`security:sql-injection:${relPath}:${lineNo}`, false, {
      file: relPath,
      impact: 'critical',
      line: lineNo,
      message: `CRITICAL: SQL injection risk — SQL query built via string concatenation/interpolation of an identifier at ${relPath}:${lineNo}`,
      suggestion: 'Use parameterised queries (e.g. conn.query("...WHERE id = ?", [id])) or a tagged-template SQL builder (sql`...`) instead of concatenating/interpolating identifiers into SQL text',
    });
  }

  /**
   * MD5 / SHA-1 used to hash a CREDENTIAL.
   *
   * The hard part of this rule is not detecting md5 — it is not drowning the
   * customer in false positives. MD5 and SHA-1 are perfectly legitimate, and
   * extremely common, for non-security work: cache keys, ETags, content
   * addressing, checksums, cache-busting hashes, test fixtures. A rule that
   * flagged every `createHash('md5')` would fire constantly on correct code
   * and teach people to ignore this module.
   *
   * So it fires only when a CREDENTIAL is being hashed — the identifier
   * feeding the hash, or the thing being assigned, names a password or
   * secret. Fast hashes are wrong there specifically because they are fast:
   * they make offline brute-force cheap. The fix is bcrypt/scrypt/argon2,
   * not "use sha256", so the suggestion says so.
   *
   * Gap found 2026-07-28 by scanning a fixture of genuinely-vulnerable code
   * to measure false NEGATIVES: `grep -rln md5 src/modules/` returned
   * nothing at all, while every competitor ships this check (KI #89).
   */
  _checkWeakPasswordHashing(projectRoot, result) {
    const files = this._collectFiles(projectRoot, JS_SOURCE_EXTS);
    const SCANNER_PATH_RE = /(?:^|\/)(?:src\/modules|src\/core|tests)\//;

    // A weak, fast digest being constructed.
    const WEAK_HASH_RE = /createHash\s*\(\s*['"`](md5|sha1|sha-1)['"`]/i;
    // Credential-ish naming, in the hashed value or the assignment target.
    //
    // Two classes, and the distinction matters. The unambiguous words are
    // matched as SUBSTRINGS because these functions are named in camelCase —
    // `\bpassword\b` does not match `hashPassword`, which is precisely how
    // this code is written in the wild (that boundary cost me the first
    // version of this rule). The ambiguous short words stay word-bounded,
    // because `pin` inside "spinner" and `token` inside "tokenizer" would
    // otherwise drag innocent hashes in.
    const CREDENTIAL_STRONG_RE = /(?:password|passwd|passphrase|secret|credential|api[_-]?key)/i;
    const CREDENTIAL_WEAK_RE = /\b(?:pwd|pin|token|salt)\b/i;

    for (const file of files) {
      const relPath = path.relative(projectRoot, file);
      if (SCANNER_PATH_RE.test(relPath.replace(/\\/g, '/'))) continue;

      let content;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (this._isCommentLine(line)) continue;
        const m = line.match(WEAK_HASH_RE);
        if (!m) continue;
        if (this._isInsideStringLiteral(line, m.index)) continue;

        // The credential can be named on this line (`.update(password)`) or
        // on the enclosing function/assignment a couple of lines up
        // (`function hashPassword(pw) {`). Keep the window tight so an
        // unrelated password mention elsewhere in the file cannot drag an
        // innocent cache-key hash into a finding.
        const windowText = lines.slice(Math.max(0, i - 2), i + 2).join('\n');
        if (!CREDENTIAL_STRONG_RE.test(windowText) && !CREDENTIAL_WEAK_RE.test(windowText)) continue;

        const algo = m[1].toLowerCase();
        result.addCheck(`security:weak-password-hash:${relPath}:${i + 1}`, false, {
          file: relPath,
          impact: 'critical',
          line: i + 1,
          column: m.index,
          severity: 'error',
          message: `${relPath}:${i + 1} CRITICAL: ${algo.toUpperCase()} used to hash a credential — fast hashes make offline brute-force cheap`,
          suggestion: 'Use a deliberately slow, salted KDF: bcrypt, scrypt, or argon2id. Switching to SHA-256 does NOT fix this — the problem is speed, not collision resistance.',
        });
        break; // one finding per file; the remedy is the same throughout
      }
    }
  }

  /**
   * Prototype pollution — a USER-CONTROLLED key in a bracket assignment.
   *
   * The whole difficulty is precision. `obj[key] = value` is one of the most
   * common lines in JavaScript and is almost always fine; a rule that flagged
   * dynamic assignment generally would bury the customer. So this requires
   * the key expression to trace *directly* to request input —
   *
   *     target[req.body.key] = req.body.value;   // __proto__ gets through
   *
   * — which is the shape that actually lets an attacker set `__proto__`,
   * `constructor` or `prototype` on Object and poison every object in the
   * process.
   *
   * It also stands down when the author has clearly thought about it: a
   * nearby `__proto__`/`constructor`/`prototype` denylist,
   * `Object.create(null)`, `hasOwnProperty`, or a `Map` means the guard is
   * already there and a finding would be noise on correct code.
   *
   * Gap found 2026-07-28 by scanning genuinely-vulnerable code to measure
   * false negatives — there was no `__proto__` detection anywhere in the
   * engine (KI #89).
   */
  _checkPrototypePollution(projectRoot, result) {
    const files = this._collectFiles(projectRoot, JS_SOURCE_EXTS);
    const SCANNER_PATH_RE = /(?:^|\/)(?:src\/modules|src\/core|tests)\//;

    // `something[req.body…] = ` / `[req.query…]` / `[req.params…]`, also
    // ctx/request/event for Koa/Lambda-style handlers.
    const SINK_RE =
      /[\w$\].]\s*\[\s*(?:req|request|ctx|event)\.(?:body|query|params|payload)\b[^\]]*\]\s*=(?!=)/;
    // Evidence the author already defends against this.
    const GUARD_RE =
      /__proto__|\bconstructor\b|\bprototype\b|Object\.create\s*\(\s*null\s*\)|hasOwnProperty|new\s+Map\b|\bfreeze\s*\(/;

    for (const file of files) {
      const relPath = path.relative(projectRoot, file);
      if (SCANNER_PATH_RE.test(relPath.replace(/\\/g, '/'))) continue;

      let content;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (this._isCommentLine(line)) continue;
        const m = line.match(SINK_RE);
        if (!m) continue;
        if (this._isInsideStringLiteral(line, m.index)) continue;

        // Wider window than the weak-hash check: a key denylist is usually a
        // few lines above the assignment, not adjacent to it.
        const windowText = lines.slice(Math.max(0, i - 6), i + 3).join('\n');
        if (GUARD_RE.test(windowText)) continue;

        result.addCheck(`security:prototype-pollution:${relPath}:${i + 1}`, false, {
          file: relPath,
          impact: 'critical',
          line: i + 1,
          column: m.index,
          severity: 'error',
          message: `${relPath}:${i + 1} CRITICAL: user-controlled key written straight into an object — a request supplying "__proto__" poisons Object for the whole process`,
          suggestion: 'Reject __proto__/constructor/prototype keys, or store user-keyed data in a `new Map()` / `Object.create(null)` instead of a plain object.',
        });
        break; // one finding per file; the remedy is the same throughout
      }
    }
  }

  /**
   * Path traversal — request input reaching a filesystem call.
   *
   * The trap this rule exists to catch is that `path.join` looks like a fix
   * and is not one:
   *
   *     fs.readFileSync(path.join('/data', req.query.file))
   *
   * `join` normalises `..` segments rather than rejecting them, so
   * `?file=../../etc/passwd` escapes `/data` cleanly. Plenty of code is
   * written this way believing it is safe, which is exactly why the rule is
   * worth having.
   *
   * Only `.createReadStream(req.` was matched before 2026-07-28, so the
   * common `readFile`/`writeFile` forms were invisible (KI #89).
   *
   * Stands down on the real defences: `basename()` (discards directory
   * parts entirely), or a `resolve()`/`normalize()` paired with a
   * `startsWith` containment check, or an explicit `includes('..')`
   * rejection. `path.join` on its own is deliberately NOT accepted as a
   * guard — treating it as one would be endorsing the bug.
   */
  _checkPathTraversal(projectRoot, result) {
    const files = this._collectFiles(projectRoot, JS_SOURCE_EXTS);
    const SCANNER_PATH_RE = /(?:^|\/)(?:src\/modules|src\/core|tests)\//;

    const FS_SINK_RE =
      /\b(?:fs|fsp|fsPromises)\s*\.\s*(?:promises\s*\.\s*)?(?:readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|createReadStream|createWriteStream|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|open|openSync)\s*\([^)]*(?:req|request|ctx|event)\s*\.\s*(?:body|query|params|payload)\b/;
    // sendFile/download take a path just as directly.
    const RES_SINK_RE =
      /\bres\s*\.\s*(?:sendFile|download)\s*\([^)]*(?:req|request|ctx|event)\s*\.\s*(?:body|query|params|payload)\b/;
    // The actual defences. path.join is NOT one of them.
    const GUARD_RE =
      /\bbasename\s*\(|startsWith\s*\(|\.includes\s*\(\s*['"`]\.\.['"`]\s*\)|\bindexOf\s*\(\s*['"`]\.\.['"`]\s*\)|allow(?:ed)?[_-]?(?:list|files|paths)/i;

    for (const file of files) {
      const relPath = path.relative(projectRoot, file);
      if (SCANNER_PATH_RE.test(relPath.replace(/\\/g, '/'))) continue;

      let content;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (this._isCommentLine(line)) continue;
        const m = line.match(FS_SINK_RE) || line.match(RES_SINK_RE);
        if (!m) continue;
        if (this._isInsideStringLiteral(line, m.index)) continue;

        const windowText = lines.slice(Math.max(0, i - 6), i + 3).join('\n');
        if (GUARD_RE.test(windowText)) continue;

        result.addCheck(`security:path-traversal:${relPath}:${i + 1}`, false, {
          file: relPath,
          impact: 'critical',
          line: i + 1,
          column: m.index,
          severity: 'error',
          message: `${relPath}:${i + 1} CRITICAL: request input reaches a filesystem path — "../../etc/passwd" escapes the intended directory (path.join normalises "..", it does not reject it)`,
          suggestion: 'Take path.basename() of the user value, or resolve() it and verify the result startsWith the intended root before touching the filesystem. path.join alone is not a defence.',
        });
        break; // one finding per file; the remedy is the same throughout
      }
    }
  }

  _checkFilePermissions(projectRoot, result) {
    const sensitiveFiles = ['.env', 'key.pem', 'cert.pem', 'id_rsa', 'credentials.json'];
    for (const filename of sensitiveFiles) {
      const filePath = path.join(projectRoot, filename);
      if (fs.existsSync(filePath)) {
        try {
          const stats = fs.statSync(filePath);
          const mode = (stats.mode & 0o777).toString(8);
          if (mode !== '600' && mode !== '400') {
            result.addCheck(`security:permissions:${filename}`, false, {
              file: filename,
              expected: '600 or 400',
              actual: mode,
              message: `${filename} has overly permissive permissions: ${mode}`,
              suggestion: `Run "chmod 600 ${filename}" to restrict access`,
            });
          }
        } catch {
          // Can't check permissions, skip
        }
      }
    }
  }

  _checkPackageScripts(projectRoot, result) {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const scripts = pkg.scripts || {};
      const suspicious = ['curl', 'wget', 'nc ', 'netcat', 'base64', '| sh', '| bash'];

      for (const [name, cmd] of Object.entries(scripts)) {
        for (const pattern of suspicious) {
          if (cmd.includes(pattern)) {
            result.addCheck(`security:script:${name}`, false, {
              message: `Suspicious pattern "${pattern}" in script "${name}"`,
              suggestion: 'Review this script for supply chain attack vectors',
            });
          }
        }
      }
    } catch {
      // Invalid package.json handled by syntax module
    }
  }

  _checkNpmAuth(projectRoot, result) {
    const npmrcPath = path.join(projectRoot, '.npmrc');
    if (fs.existsSync(npmrcPath)) {
      const content = fs.readFileSync(npmrcPath, 'utf-8');
      if (content.includes('_authToken') || content.includes('_auth=')) {
        result.addCheck('security:npmrc-token', false, {
          file: '.npmrc',
          message: 'Auth token found in .npmrc',
          suggestion: 'Use environment variables for npm auth tokens',
        });
      }
    }
  }

  _scanForSecrets(projectRoot, result) {
    const secretExtensions = [
      '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.java', '.rb',
      '.env', '.yml', '.yaml', '.json', '.toml', '.cfg', '.ini', '.conf',
    ];
    const extraExcludes = ['vendor', '__pycache__', '.next', '.nuxt'];
    const files = this._collectFiles(projectRoot, secretExtensions, extraExcludes);

    const secretPatterns = [
      // AWS keys
      { regex: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g, name: 'AWS Access Key' },
      // GitHub tokens
      { regex: /(?<![a-zA-Z0-9_])(ghp_[a-zA-Z0-9]{36,}|gho_[a-zA-Z0-9]{36,}|ghu_[a-zA-Z0-9]{36,}|ghs_[a-zA-Z0-9]{36,}|ghr_[a-zA-Z0-9]{36,})/g, name: 'GitHub Token' },
      // Slack tokens
      { regex: /(?<![a-zA-Z0-9_])(xoxb-[a-zA-Z0-9-]+|xoxp-[a-zA-Z0-9-]+|xoxs-[a-zA-Z0-9-]+)/g, name: 'Slack Token' },
      // Stripe keys
      { regex: /(?<![a-zA-Z0-9_])(sk_live_[a-zA-Z0-9]{20,}|pk_live_[a-zA-Z0-9]{20,}|sk_test_[a-zA-Z0-9]{20,})/g, name: 'Stripe Key' },
      // Private keys
      { regex: /-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, name: 'Private Key' },
      // JWT tokens (eyJ followed by base64)
      { regex: /(?<![a-zA-Z0-9_/])(eyJ[a-zA-Z0-9_-]{30,}\.eyJ[a-zA-Z0-9_-]{30,}\.[a-zA-Z0-9_-]+)/g, name: 'JWT Token' },
      // Database connection strings with credentials
      { regex: /(mongodb(\+srv)?|postgres|postgresql|mysql|mariadb|redis|amqp):\/\/[^:\s]+:[^@\s]+@[^\s"'`]+/gi, name: 'Database Connection String with Credentials' },
      // Generic API key assignments
      { regex: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][a-zA-Z0-9_\-/.]{10,}['"]/gi, name: 'API Key' },
      // Generic secrets/passwords/tokens in assignments
      { regex: /(?:secret|password|passwd|pwd|token|auth_token|access_token|refresh_token|client_secret)\s*[:=]\s*['"][a-zA-Z0-9_\-/.+]{8,}['"]/gi, name: 'Hardcoded Secret/Password/Token' },
      // High-entropy hex strings assigned to suspicious variable names
      { regex: /(?:secret|key|token|password|credential|auth)\s*[:=]\s*['"][0-9a-fA-F]{32,}['"]/gi, name: 'High-Entropy Hex String' },
      // High-entropy base64 strings assigned to suspicious variable names
      { regex: /(?:secret|key|token|password|credential|auth)\s*[:=]\s*['"][A-Za-z0-9+/]{32,}={0,2}['"]/gi, name: 'High-Entropy Base64 String' },
    ];

    let totalFindings = 0;

    for (const file of files) {
      const relPath = path.relative(projectRoot, file);
      const basename = path.basename(file);

      // Skip .env.example and similar template files
      if (basename === '.env.example' || basename === '.env.sample' || basename === '.env.template') {
        continue;
      }

      // Skip test files that explicitly test secret patterns
      if (/\.(test|spec|mock|fixture)\./i.test(basename) || /\/__tests__\//.test(relPath) || /\/test\//.test(relPath) || /\/tests\//.test(relPath)) {
        continue;
      }

      let content;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Skip comment lines that document patterns rather than containing real secrets.
        // (Avoid spelling out task-marker words here — the never-idle hook greps
        // the codebase for them and would flag this regex as an unresolved task.)
        const COMMENT_DOC_TOKENS = ['example', 'e.g.', 'sample', 'placeholder', 'dummy', 'fake', 'test', 'regex', 'pattern']
          .concat([String.fromCharCode(84, 79, 68, 79), String.fromCharCode(78, 79, 84, 69)]); // task-markers expressed as char codes
        const docRe = new RegExp(`^\\s*(//|#|/?\\*|--|;)\\s*(${COMMENT_DOC_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i');
        if (docRe.test(trimmed)) {
          continue;
        }
        // ANY comment line is documentation, whatever it says — a doc
        // comment reading `# api_key = "CHANGEME_XXXXXXXX"` is not a
        // credential in the binary. (sinatra's own docs blocked the gate on
        // exactly this in the 2026-08-18 audit.) Real secrets in comments do
        // exist but are the exception; they still surface through the
        // dedicated `secrets` module's entropy checks.
        if (/^\s*(\/\/|#(?!!)|\/?\*|--|;|<!--)/.test(trimmed)) {
          continue;
        }
        // Obvious placeholders are not secrets: CHANGEME, your-key-here,
        // xxxx, <insert>, process.env lookups on the same line.
        //
        // `\$\{[A-Z_]+\}` used to be in this list and was REMOVED. The list
        // carries an /i flag, so that alternative matched any `${ident}` in
        // any case and discarded the WHOLE line — which meant
        //     postgresql://admin:hunter2@${dbHost}/prod
        // (a real committed password) was invisible, while
        //     postgresql://${POSTGRES_USER:-gatetest}:${POSTGRES_PASSWORD:-gatetest}@…
        // (no secret at all) still fired, because `:-default` is not
        // `[A-Z_]+`. It muted the case it should have caught and missed the
        // case it was written for. Expansions are now masked positionally by
        // `maskInterpolations` below, which handles both correctly.
        // Measured by tests/secrets-interpolated-credentials.test.js.
        if (/CHANGE_?ME|YOUR[_-]?[A-Z_]*(KEY|SECRET|TOKEN)|<[^>]*(key|secret|token|password)[^>]*>|x{6,}|process\.env\.|os\.environ|getenv\(|placeholder|REPLACE_?ME|insert[_-]?(key|token)/i.test(line)) {
          continue;
        }

        // A credential built out of variable EXPANSIONS is a reference, not a
        // committed secret. Matching runs against a length-preserving mask so
        // an expansion cannot supply the characters a credential is made of,
        // while `match.index` still points at the real line.
        //
        // Deliberately NOT a whole-line skip: masking removes only the
        // expansion, so a literal secret sharing the line — or sitting in the
        // password position beside an expanded username — still matches. See
        // tests/secrets-interpolated-credentials.test.js.
        const maskedLine = maskInterpolations(line);

        let matchedThisLine = false;
        for (const pattern of secretPatterns) {
          if (matchedThisLine) break; // one line = one secret, not one per overlapping pattern
          pattern.regex.lastIndex = 0;
          const match = pattern.regex.exec(maskedLine);
          if (match) {
            // The permissive userinfo classes of the connection-string rule
            // are the one place a mask can still satisfy the pattern, so the
            // password position is checked explicitly.
            if (credentialIsFullyExpanded(match[0])) continue;
            matchedThisLine = true;
            // Preview comes from the ORIGINAL line — the mask is
            // length-preserving, so the offsets carry over.
            const matchedText = line.slice(match.index, match.index + match[0].length);
            const redacted = matchedText.length > 10
              ? matchedText.slice(0, 6) + '***REDACTED***' + matchedText.slice(-2)
              : '***REDACTED***';

            result.addCheck(`security:secret:${relPath}:${i + 1}`, false, {
              file: relPath,
              line: i + 1,
              patternType: pattern.name,
              message: `Potential ${pattern.name} found in ${relPath}:${i + 1}`,
              preview: redacted,
              suggestion: 'Move this value to environment variables or a secrets manager. Never commit secrets to source control.',
            });
            totalFindings++;
          }
        }
      }
    }

    const reported = this._liveFindingCount(result, 'security:secret:', totalFindings);
    if (reported === 0) {
      result.addCheck('security:secrets-scan', true, {
        message: `Scanned ${files.length} files for hardcoded secrets — none found`,
      });
    } else {
      result.addCheck('security:secrets-scan', false, {
        message: `Found ${reported} potential secret(s) across scanned files`,
        suggestion: 'Review all findings and move secrets to environment variables or a secrets manager',
      });
    }
  }

  async _checkSecurityHeaders(config, result) {
    let url;
    try {
      url = config.get('liveCrawler.url') || (config.getModuleConfig('security') || {}).url;
    } catch {
      url = null;
    }

    if (!url) {
      result.addCheck('security:headers', true, {
        message: 'No live URL configured — skipping security headers check',
      });
      return;
    }

    try {
      const headers = await this._fetchHeaders(url, 10000);

      const requiredHeaders = [
        { name: 'strict-transport-security', label: 'Strict-Transport-Security (HSTS)',
          check: (v) => v && v.includes('max-age'),
          suggestion: 'Add header: Strict-Transport-Security: max-age=31536000; includeSubDomains' },
        { name: 'content-security-policy', label: 'Content-Security-Policy (CSP)',
          check: (v) => !!v,
          suggestion: 'Add a Content-Security-Policy header to prevent XSS and injection attacks' },
        { name: 'x-frame-options', label: 'X-Frame-Options',
          check: (v) => v && /^(deny|sameorigin)$/i.test(v),
          suggestion: 'Add header: X-Frame-Options: DENY (or SAMEORIGIN)' },
        { name: 'x-content-type-options', label: 'X-Content-Type-Options',
          check: (v) => v === 'nosniff',
          suggestion: 'Add header: X-Content-Type-Options: nosniff' },
        { name: 'referrer-policy', label: 'Referrer-Policy',
          check: (v) => !!v,
          suggestion: 'Add header: Referrer-Policy: strict-origin-when-cross-origin' },
      ];

      for (const req of requiredHeaders) {
        const value = headers[req.name];
        const passed = req.check(value);
        result.addCheck(`security:header:${req.name}`, passed, {
          message: passed
            ? `${req.label}: ${value}`
            : `Missing or invalid ${req.label}`,
          suggestion: passed ? undefined : req.suggestion,
        });
      }

      // Headers that should NOT exist (information disclosure)
      const serverHeader = headers['server'];
      if (serverHeader && /\/[\d.]/.test(serverHeader)) {
        result.addCheck('security:header:server-version', false, {
          message: `Server header reveals version: "${serverHeader}"`,
          suggestion: 'Remove version info from Server header to reduce attack surface',
        });
      }

      if (headers['x-powered-by']) {
        result.addCheck('security:header:x-powered-by', false, {
          message: `X-Powered-By header exposes technology: "${headers['x-powered-by']}"`,
          suggestion: 'Remove X-Powered-By header (e.g., app.disable("x-powered-by") in Express)',
        });
      }

    } catch (err) {
      result.addCheck('security:headers', false, {
        message: `Failed to check security headers: ${err.message}`,
        suggestion: 'Ensure the URL is reachable and the server is running',
      });
    }
  }

  _checkDockerSecurity(projectRoot, result) {
    const dockerfiles = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'];

    for (const df of dockerfiles) {
      const filePath = path.join(projectRoot, df);
      if (!fs.existsSync(filePath)) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);

      // Running as root
      if (df === 'Dockerfile') {
        const hasUser = lines.some(l => /^\s*USER\s+(?!root)/i.test(l));
        if (!hasUser) {
          result.addCheck('security:docker-root', false, {
            file: df,
            severity: 'error',
            message: 'Dockerfile runs as root — no USER directive found',
            suggestion: 'Add "USER node" or "USER appuser" before the CMD instruction',
          });
        }

        // Using :latest tag
        for (let i = 0; i < lines.length; i++) {
          if (/^\s*FROM\s+\S+:latest/i.test(lines[i]) || /^\s*FROM\s+\S+\s*$/i.test(lines[i])) {
            result.addCheck(`security:docker-latest:${i + 1}`, false, {
              file: df, line: i + 1,
              severity: 'warning',
              message: 'Using :latest or untagged image — builds are not reproducible',
              suggestion: 'Pin to a specific version: e.g., node:20-alpine',
            });
          }
        }

        // COPY . . without .dockerignore
        if (content.includes('COPY . .') || content.includes('ADD . .')) {
          if (!fs.existsSync(path.join(projectRoot, '.dockerignore'))) {
            result.addCheck('security:docker-no-dockerignore', false, {
              file: df,
              severity: 'error',
              message: 'COPY/ADD entire directory without .dockerignore — secrets may be included',
              suggestion: 'Create a .dockerignore file excluding .env, .git, node_modules, etc.',
            });
          }
        }

        // Exposing secrets via ENV
        for (let i = 0; i < lines.length; i++) {
          if (/^\s*ENV\s+.*(?:password|secret|token|key|api_key)/i.test(lines[i])) {
            result.addCheck(`security:docker-env-secret:${i + 1}`, false, {
              file: df, line: i + 1,
              severity: 'error',
              message: 'Secret exposed in Dockerfile ENV instruction — visible in image layers',
              suggestion: 'Use --mount=type=secret or runtime environment variables instead',
            });
          }
        }
      }

      // docker-compose: privileged mode
      if (df.includes('compose')) {
        if (content.includes('privileged: true')) {
          result.addCheck('security:docker-privileged', false, {
            file: df,
            severity: 'error',
            message: 'Container running in privileged mode — full host access',
            suggestion: 'Remove "privileged: true" unless absolutely necessary',
          });
        }

        // Exposed ports to 0.0.0.0
        const portPattern = /ports:\s*\n(\s+-\s*['"]?\d+:\d+)/g;
        if (portPattern.test(content)) {
          result.addCheck('security:docker-ports', true, {
            file: df,
            severity: 'info',
            message: 'Review exposed ports — bind to 127.0.0.1 for local-only services',
          });
        }
      }
    }
  }

  _checkGitignore(projectRoot, result) {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      if (fs.existsSync(path.join(projectRoot, '.git'))) {
        result.addCheck('security:gitignore-missing', false, {
          // Warning, not error: no .gitignore is a real risk signal but not
          // itself a defect — the secrets module blocks on any actually
          // committed secret. Blocking a brand-new repo's first scan over
          // missing setup files trains distrust (first-run audit 2026-07-23).
          severity: 'warning',
          message: 'Git repository has no .gitignore — sensitive files may be committed',
          suggestion: 'Create a .gitignore excluding .env, node_modules, .pem, credentials, etc.',
        });
      }
      return;
    }

    const content = fs.readFileSync(gitignorePath, 'utf-8').toLowerCase();

    const mustIgnore = [
      { pattern: '.env', check: content.includes('.env'), label: '.env files' },
      { pattern: 'node_modules', check: content.includes('node_modules'), label: 'node_modules' },
      { pattern: '.pem', check: content.includes('.pem') || content.includes('*.pem'), label: 'PEM keys' },
    ];

    for (const item of mustIgnore) {
      if (!item.check) {
        // Verify the files actually exist before flagging — outside test /
        // fixture / example dirs, which commit such files on purpose.
        const FIXTURE_RE = /(^|[\\/])(tests?|__tests__|specs?|fixtures?|testdata|test_apps|examples?|docs|benchmarks|known-bad|reliability-corpus)([\\/]|$)/i;
        const exists = this._collectFiles(projectRoot, ['*']).some(f => {
          const rel = path.relative(projectRoot, f);
          if (FIXTURE_RE.test(rel)) return false;
          const base = path.basename(f);
          if (/\.(example|sample|template|dist)$/.test(base)) return false;
          return base.includes(item.pattern) || rel.includes(item.pattern);
        });
        if (exists) {
          // The `secrets` module owns this finding at error severity when a
          // real file is at risk; this one is the corroborating advisory.
          result.addCheck(`security:gitignore:${item.pattern}`, false, {
            file: '.gitignore',
            severity: 'warning',
            message: `${item.label} present in the project but not in .gitignore`,
            suggestion: `Add "${item.pattern}" to .gitignore`,
          });
        }
      }
    }
  }

  _checkLicenseCompliance(projectRoot, result) {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

      if (Object.keys(allDeps).length === 0) return;

      // Check for known copyleft/restrictive licenses in node_modules
      const nodeModules = path.join(projectRoot, 'node_modules');
      if (!fs.existsSync(nodeModules)) return;

      const copyleftLicenses = ['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'AGPL-1.0', 'SSPL-1.0', 'EUPL-1.1', 'EUPL-1.2'];
      const flagged = [];

      for (const dep of Object.keys(allDeps).slice(0, 50)) {
        const depPkgPath = path.join(nodeModules, dep, 'package.json');
        if (!fs.existsSync(depPkgPath)) continue;

        try {
          const depPkg = JSON.parse(fs.readFileSync(depPkgPath, 'utf-8'));
          const license = depPkg.license || '';

          if (copyleftLicenses.some(cl => license.toUpperCase().includes(cl.toUpperCase()))) {
            flagged.push({ name: dep, license });
          }
        } catch { /* skip */ }
      }

      if (flagged.length > 0) {
        for (const dep of flagged.slice(0, 5)) {
          result.addCheck(`security:license:${dep.name}`, false, {
            severity: 'warning',
            message: `Dependency "${dep.name}" has copyleft license: ${dep.license}`,
            suggestion: 'Copyleft licenses may require you to open-source your code. Review compliance.',
          });
        }
      } else {
        result.addCheck('security:licenses', true, {
          severity: 'info',
          message: 'No copyleft license conflicts detected in dependencies',
        });
      }
    } catch { /* skip */ }
  }

  _checkEnvFiles(projectRoot, result) {
    // Check if .env files are committed (should never be)
    const envFiles = ['.env', '.env.local', '.env.production', '.env.staging'];
    const gitDir = path.join(projectRoot, '.git');

    if (!fs.existsSync(gitDir)) return;

    for (const envFile of envFiles) {
      const envPath = path.join(projectRoot, envFile);
      if (!fs.existsSync(envPath)) continue;

      // Check if file is tracked by git
      const { exitCode } = this._exec(`git ls-files --error-unmatch "${envFile}" 2>/dev/null`, {
        cwd: projectRoot,
      });

      if (exitCode === 0) {
        result.addCheck(`security:env-tracked:${envFile}`, false, {
          file: envFile,
          severity: 'error',
          message: `${envFile} is tracked by git — secrets are in your repo history`,
          suggestion: `Add "${envFile}" to .gitignore and remove from tracking: git rm --cached ${envFile}`,
        });
      }

      // Check env file contents for real-looking secrets (not placeholders)
      const content = fs.readFileSync(envPath, 'utf-8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#')) continue;

        const match = line.match(/^([^=]+)=(.+)$/);
        if (match) {
          const value = match[2].trim().replace(/^['"]|['"]$/g, '');
          // Flag values that look like real secrets (high entropy, not placeholders)
          if (value.length > 20 && !/^(your_|changeme|placeholder|example|xxx|test|dummy)/i.test(value)) {
            if (/[A-Za-z]/.test(value) && /[0-9]/.test(value) && /[^A-Za-z0-9]/.test(value)) {
              result.addCheck(`security:env-secret:${envFile}:${match[1]}`, false, {
                file: envFile,
                line: i + 1,
                severity: 'warning',
                message: `${match[1]} in ${envFile} appears to contain a real secret`,
                suggestion: 'Ensure this file is in .gitignore and never committed',
              });
              break; // One warning per file
            }
          }
        }
      }
    }
  }

  _fetchHeaders(url, timeout) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new (require('url').URL)(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      const req = client.get(url, { timeout, headers: { 'User-Agent': 'GateTest/1.0' } }, (res) => {
        resolve(res.headers);
        res.resume();
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }
}

module.exports = SecurityModule;
