/**
 * Security Module - Comprehensive security scanning.
 * Checks headers, dependencies, OWASP patterns, CSP, CORS, and more.
 */

const BaseModule = require('./base-module');
const { SESSION_MIDDLEWARE_RE } = require('../core/route-grammar');
const { JS_SOURCE_EXTS } = require('../core/source-extensions');
const { innerHtmlAssignmentIsSafe, splitTopLevel } = require('../core/inner-html-safety');
const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const { literalKindAt } = require('../core/source-strip');
// The published-example list lives with the module that owns the doctrine
// (secrets.js PUBLISHED_EXAMPLE_CREDENTIALS) — one list, two rules.
const { PUBLISHED_EXAMPLE_CREDENTIALS } = require('./secrets');
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
const SQL_TEMPLATE_RE = new RegExp('(?<![\\w$)\\]])`(?:' + SQL_KEYWORDS + ')\\b(?:(?!`).)*\\$\\{[^}]+\\}(?:(?!`).)*`', 'i');
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

/**
 * A connection string whose credential is a DEVELOPMENT DEFAULT, not a leak.
 *
 * prisma/prisma @ HEAD (2026-09-05) produced 12 `security:secret` findings,
 * every one of them this shape:
 *   postgres://postgres:postgres@127.0.0.1:5433/prisma        (CI service)
 *   postgresql://diamond:diamond@localhost:5432/diamond       (7 fixtures)
 *   DATABASE_URL="postgresql://user:password@localhost/mydb"  (init template)
 * Two shapes, both precise:
 *   1. The password IS a credential word — `password`, `secret`, `changeme`.
 *      Nobody's secret is the word "password" (the same principle the
 *      identifier-keyed label rule already applies). Host does not matter.
 *   2. Username and password are IDENTICAL and the host is not routable —
 *      loopback, `localhost`, or a single-label name (`db`, `postgres`: a
 *      docker-compose / k8s service). That is the default credential of a
 *      local container. `postgres:postgres@db.example.com` STILL fires:
 *      a default credential on a reachable host is worse, not better.
 * A distinct password on localhost (`admin:hunter2@localhost`) still fires —
 * it may be the same password the author uses everywhere.
 */
const PLACEHOLDER_PASSWORD_RE = /^(?:password|passwd|passwort|pwd|pass|secret|changeme|change_me|example|placeholder|x{3,})$/i;
const LOCAL_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal|[a-z0-9_-]+)$/i;

function connectionStringIsDevDefault(matchedText) {
  const schemeEnd = matchedText.indexOf('://');
  if (schemeEnd === -1) return false;
  const at = matchedText.indexOf('@', schemeEnd + 3);
  if (at === -1) return false;
  const userinfo = matchedText.slice(schemeEnd + 3, at);
  const colon = userinfo.lastIndexOf(':');
  if (colon === -1) return false;
  const user = userinfo.slice(0, colon);
  const password = userinfo.slice(colon + 1);
  if (!password) return false;
  if (PLACEHOLDER_PASSWORD_RE.test(password)) return true;
  const host = matchedText.slice(at + 1).split(/[/:?#]/)[0];
  return user === password && LOCAL_HOST_RE.test(host);
}

// ---------------------------------------------------------------------------
// Math.random() is a SECURITY finding only when the value is a credential.
//
// The previous rule keyed on `id`, `code`, `key`, `reset`, `invite` as bare
// SUBSTRINGS of the assignment target. nestjs/nest @ HEAD (2026-09-05): five
// blocking findings, all `id = Math.random()` — a request-context id
// (`packages/core/helpers/context-id-factory.ts:14`), two Kafka fixture
// entity ids, a request-logger id. trpc: ten, all `id:` / `nonce` in tests
// and examples. None was a secret. `id` also matched INSIDE `valid`, `grid`,
// `paid`; `key` matched React's `key: Math.random()` list anti-pattern;
// `code` matched `statusCode`, `zipCode`.
//
// Identifiers are split into WORDS (camelCase, snake_case, kebab, dotted
// member chains) and judged as words, Doctrine §5: tokens, not substrings.
//   sensitive on their own:  token secret nonce otp password passcode pin
//                            session salt csrf xsrf apikey totp
//   sensitive when qualified: `key` after api/secret/private/signing/…
//                             `code` after verification/confirm/activation/…
//   never, whatever else is on the identifier: timeout delay interval ttl
//                             jitter backoff expiry — those are the words
//                             that make `sessionTimeout = base * Math.random()`
//                             a retry, not a credential.
// One extra shape: the SMS-OTP snippet `Math.floor(100000 + Math.random() *
// 900000)` assigned to a bare `code`/`digits` — the digit range is the tell.
// ---------------------------------------------------------------------------
const RANDOM_SENSITIVE_WORDS = new Set([
  'token', 'secret', 'nonce', 'otp', 'password', 'passwd', 'passcode', 'pin',
  'session', 'sessionid', 'salt', 'csrf', 'xsrf', 'apikey', 'totp', 'mfa', '2fa',
]);
const RANDOM_KEY_QUALIFIERS = new Set([
  'api', 'secret', 'private', 'signing', 'sign', 'encryption', 'encrypt',
  'session', 'access', 'auth', 'license', 'licence', 'recovery', 'master',
  'hmac', 'jwt', 'shared', 'client', 'consumer', 'app',
]);
const RANDOM_CODE_QUALIFIERS = new Set([
  'verification', 'verify', 'confirmation', 'confirm', 'activation', 'activate',
  'reset', 'auth', 'authorization', 'authorisation', 'otp', 'security', 'access',
  'recovery', 'invite', 'invitation', 'sms', 'login', 'signin', 'backup',
  'onetime', 'one', 'totp', 'mfa', '2fa', 'pin', 'referral', 'promo', 'coupon',
]);
const RANDOM_VOID_WORDS = new Set([
  'timeout', 'delay', 'interval', 'ttl', 'duration', 'expiry', 'expires',
  'expiration', 'jitter', 'backoff', 'index', 'offset', 'count', 'length',
  'size', 'width', 'height', 'color', 'colour', 'seed', 'sample', 'ratio',
  'chance', 'probability', 'weight', 'ms', 'seconds', 'millis',
]);
const OTP_RANGE_RE = /Math\.floor\s*\([^)]*Math\.random\s*\(\s*\)\s*\*\s*\d{4,}|\d{4,}\s*\+\s*Math\.random\s*\(/;

function identifierWords(ident) {
  return String(ident)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function wordsNameACredential(words, line) {
  if (words.some((w) => RANDOM_VOID_WORDS.has(w))) return false;
  if (words.some((w) => RANDOM_SENSITIVE_WORDS.has(w))) return true;
  for (let i = 1; i < words.length; i++) {
    if (words[i] === 'key' && RANDOM_KEY_QUALIFIERS.has(words[i - 1])) return true;
    if (words[i] === 'code' && RANDOM_CODE_QUALIFIERS.has(words[i - 1])) return true;
  }
  const last = words[words.length - 1];
  return (last === 'code' || last === 'digits') && OTP_RANGE_RE.test(line);
}

/**
 * True when the `Math.random()` on `line` feeds a credential-shaped value:
 * the assignment / property target's words name a credential, or — for the
 * `toString(36|16)` "make me a string" idiom — any identifier on the line
 * does (`res.cookie('sessionId', Math.random().toString(36))`).
 */
function mathRandomIsSecuritySensitive(line) {
  const at = line.search(/Math\.random\s*\(/);
  if (at === -1) return false;
  // Quoted prose cannot supply the target (`"token = Math.random()"`); the
  // quoted NAMES are still consulted by the toString fallback below.
  const lhs = line.slice(0, at).replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, (q) => ' '.repeat(q.length));
  const targetRe = /([\w$.]+)\s*[:=](?!=)/g;
  let target = null;
  let m;
  while ((m = targetRe.exec(lhs)) !== null) target = m[1];
  if (target && wordsNameACredential(identifierWords(target), line)) return true;
  if (!/\.toString\s*\(\s*(?:36|16|32)\s*\)/.test(line)) return false;
  const idents = line.match(/[A-Za-z_$][\w$]*/g) || [];
  return idents.some((id) => id !== 'Math' && wordsNameACredential(identifierWords(id), line));
}

// ---------------------------------------------------------------------------
// A SQL splice made only of CONSTANTS is not an injection.
//
// prisma/prisma @ HEAD (2026-09-05): 31 `security:sql-injection` findings.
// Twenty-two interpolated nothing but a SCREAMING_SNAKE module constant —
//   await connection.query(`DROP TABLE IF EXISTS "${STORAGE_TABLE}"`);
//   await driver.query(`create schema if not exists ${TENANT_A_SCHEMA}`);
// — the codec test-kits, migration tests and fixture setup naming their own
// tables. A `const STORAGE_TABLE = 'x'` is decided by the author at write
// time; no request reaches it. `${tableName}`, `${req.query.t}`, `${i}` and
// `${entry.literal}` are NOT constants and still fire; a splice that mixes
// a constant with anything else still fires (`"${VALUE_COLUMN}" ${columnType}`
// at postgres-codec-testkit/src/index.ts:337 is reported — correctly).
// Four more were `rawSql()\`SELECT … ${1}\`` — a tagged template whose tag is
// a CALL, which the `(?<![\w$])` tag exclusion could not see. `)` or `]`
// immediately before a backtick is only ever a tag in JavaScript.
// ---------------------------------------------------------------------------
const SQL_CONSTANT_SPLICE_RE = /^\s*(?:[A-Z][A-Z0-9_]+|\d+(?:\.\d+)?)\s*$/;

function sqlSpliceIsConstantOnly(line, match) {
  const text = match[0];
  if (text.startsWith('`')) {
    const splices = [...text.matchAll(/\$\{([^}]*)\}/g)].map((s) => s[1]);
    return splices.length > 0 && splices.every((s) => SQL_CONSTANT_SPLICE_RE.test(s));
  }
  // Concat form: the match ends at the first `+ ident`; walk the rest of the
  // `+` chain on the line. Anything that is not a constant, a literal or a
  // plain identifier ends the walk as "not constant" — conservative.
  const quote = text[0];
  const closeQuote = text.indexOf(quote, 1);
  let rest = text.slice(closeQuote + 1) + line.slice(match.index + text.length);
  const piece = /^\s*\+\s*(?:([A-Za-z_$][\w.$]*)|'[^']*'|"[^"]*"|`[^`$]*`|\d+(?:\.\d+)?)/;
  let sawIdent = false;
  for (;;) {
    const p = piece.exec(rest);
    if (!p) break;
    if (p[1] !== undefined) {
      sawIdent = true;
      if (!SQL_CONSTANT_SPLICE_RE.test(p[1])) return false;
    }
    rest = rest.slice(p[0].length);
  }
  if (/^\s*\+/.test(rest)) return false; // a `+ something` we could not parse
  return sawIdent;
}

// The first createHash(...) on the masked line whose raw text names a weak
// digest. The call shape is code and survives the mask; the algorithm is
// string content the mask blanked, so `weakRe` (sticky) reads it from the raw
// line at the offset the masked match reports.
function weakHashAt(code, line, callRe, weakRe) {
  callRe.lastIndex = 0;
  let at;
  while ((at = callRe.exec(code)) !== null) {
    weakRe.lastIndex = at.index;
    const m = weakRe.exec(line);
    if (m) return m;
  }
  return null;
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
      //
      // The callee must be a shell exec: a bare `exec(` / `execSync(` (the
      // destructured child_process import) or one qualified by the module
      // (`child_process.exec`, `childProcess.execSync`, `cp.exec`). Any other
      // `<receiver>.exec(` is a different function wearing the name —
      // `RegExp#exec` (got, `/…/v.exec(\`${url.pathname}\`)`, two findings)
      // and a database handle's `db.exec(\`INSERT … ${values}\`)` (prisma's
      // sqlite fixtures) reach no shell. Measured 2026-09-05 when the match
      // moved onto the masked line: the raw form had skipped prisma only
      // because `[^)]*` stopped at a `)` inside the SQL string, and had
      // flagged got's RegExp because `[^)]*` ran through the regex body.
      { regex: /(?:\b(?:child_process|childProcess|cp)\.|(?<![\w$.]))(?:exec|execSync)\s*\(\s*(?!\[)[^)]*(?:\+|\$\{)/g, name: 'shell exec with interpolated input', severity: 'critical' },
      { regex: /\$\{.*req\.(params|query|body)/g, name: 'unsanitized user input in template', severity: 'critical' },
      { regex: /res\.redirect\s*\(\s*req\./g, name: 'open redirect risk', severity: 'high' },
      { regex: /\.createReadStream\s*\(\s*req\./g, name: 'path traversal risk', severity: 'critical' },
      // Math.random() is a SECURITY finding only when the value is a
      // credential — see `mathRandomIsSecuritySensitive` at the top of this
      // file for the word list and the nest/trpc measurement that replaced
      // the substring rule. Identifier-keyed, so a test-tree hit is a
      // warning (a test's `nonce-${Math.random()}` cache-buster is not
      // shipped), same split as the secret patterns below.
      // Not anchored: the masked line keeps `${…}` inside a template literal
      // as code, so `apiKey = \`${Math.random()}\`` fires and
      // `"const token = Math.random()"` inside a plain string does not.
      {
        regex: /Math\.random\s*\(/g,
        name: 'Math.random() for a security-sensitive value (use crypto.randomBytes / randomUUID)',
        severity: 'moderate',
        identifierKeyed: true,
        safeIf: (line) => !mathRandomIsSecuritySensitive(line),
      },
      // Reads string content (`app.disable('csrf')`), so it runs on the raw
      // line; the match start is still required to be code.
      { regex: /disable.*csrf|csrf.*disable/gi, name: 'CSRF protection disabled', severity: 'critical', readsStrings: true },
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
      const relPath = repoRelative(projectRoot, file);
      // Normalise to forward slashes for cross-platform regex match.
      const normalisedPath = relPath.replace(/\\/g, '/');
      if (SCANNER_PATH_RE.test(normalisedPath)) continue;
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split(/\r?\n/);
      // Strings, regex literals and comments blanked to spaces, offsets kept
      // (BaseModule._maskedLines — the one stripper). Every dangerous pattern
      // is matched on the masked line, so prose about eval() in a string, a
      // template literal or a block comment is not a call to eval(); the
      // per-line quote counter this replaced (2026-09-05) could not see a
      // template or a block comment that spans lines.
      const masked = this._maskedLines(content);

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
        if (SESSION_MIDDLEWARE_RE.test(live)) posture.sessionMw = true; // CJS or ESM — the CJS-only form hid ESM apps from the CSRF rule
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
          const code = masked[i] || '';
          pattern.regex.lastIndex = 0;
          const match = pattern.regex.exec(pattern.readsStrings ? line : code);
          pattern.regex.lastIndex = 0;
          if (match) {
            // A pattern that reads string content ran on the raw line; its
            // match START must still be code — a character the mask blanked
            // sits inside a string literal or a comment.
            if (pattern.readsStrings && code[match.index] !== line[match.index]) continue;
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
              ...(pattern.identifierKeyed && this._isTestPath(normalisedPath) ? { severity: 'warning' } : {}),
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
      const relPath = repoRelative(projectRoot, file);
      if (SCANNER_PATH_RE.test(relPath)) continue;

      let content;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      // Both SQL regexes read the keyword out of the quotes, so they run on
      // the raw line; whether the opening quote they start at is a real
      // delimiter is decided by the one stripper (BaseModule._maskedLines):
      // a delimiter survives the mask, a quote inside another string, a
      // template literal or a block comment is blanked. The per-line quote
      // counter this replaced (2026-09-05) could not see either spanning
      // lines.
      const masked = this._maskedLines(content);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = SQL_CONCAT_RE.exec(line) || SQL_TEMPLATE_RE.exec(line);
        if (!match) continue;
        if (this._insideLiteral(masked, lines, i, match.index)) continue;
        if (sqlSpliceIsConstantOnly(line, match)) continue;

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

  /**
   * Highest confidence among the live (unsuppressed, failing) checks under
   * `prefix`, or null when none carries a scored confidence — a rollup must
   * not block harder than the findings it counts. See the secrets rollup.
   */
  _maxLiveConfidence(result, prefix) {
    if (!result || !Array.isArray(result.checks)) return null;
    let max = null;
    for (const c of result.checks) {
      if (!c || c.passed !== false || c.suppressed) continue;
      if (typeof c.name !== 'string' || !c.name.startsWith(prefix)) continue;
      if (typeof c.confidence !== 'number') continue;
      if (max === null || c.confidence > max) max = c.confidence;
    }
    return max;
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

    // A weak, fast digest being constructed: the call shape is located on
    // the masked line, the algorithm name is string content read from the raw
    // line at that offset (sticky) — see weakHashAt.
    const CREATE_HASH_RE = /createHash\s*\(\s*['"`]/g;
    const WEAK_HASH_RE = /createHash\s*\(\s*['"`](md5|sha1|sha-1)['"`]/iy;
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
      const relPath = repoRelative(projectRoot, file);
      if (SCANNER_PATH_RE.test(relPath.replace(/\\/g, '/'))) continue;

      let content;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const lines = content.split(/\r?\n/);
      const masked = this._maskedLines(content);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (this._isCommentLine(line)) continue;
        const m = weakHashAt(masked[i] || '', line, CREATE_HASH_RE, WEAK_HASH_RE);
        if (!m) continue;

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
      const relPath = repoRelative(projectRoot, file);
      if (SCANNER_PATH_RE.test(relPath.replace(/\\/g, '/'))) continue;

      let content;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const lines = content.split(/\r?\n/);
      // The sink is matched on the masked line (BaseModule._maskedLines): a
      // `target[req.body.key] =` quoted in a string, a template literal or a
      // block comment is not an assignment.
      const masked = this._maskedLines(content);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (this._isCommentLine(line)) continue;
        const m = (masked[i] || '').match(SINK_RE);
        if (!m) continue;

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
      const relPath = repoRelative(projectRoot, file);
      if (SCANNER_PATH_RE.test(relPath.replace(/\\/g, '/'))) continue;

      let content;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const lines = content.split(/\r?\n/);
      // Sinks are matched on the masked line (BaseModule._maskedLines): a
      // `fs.readFile(… + req.query.file)` quoted in a string, a template
      // literal or a block comment reads nothing.
      const masked = this._maskedLines(content);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (this._isCommentLine(line)) continue;
        const code = masked[i] || '';
        const m = code.match(FS_SINK_RE) || code.match(RES_SINK_RE);
        if (!m) continue;

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
          // error-ok — Can't check permissions, skip
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
      // error-ok — Invalid package.json handled by syntax module
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
      { regex: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][a-zA-Z0-9_\-/.]{10,}['"]/gi, name: 'API Key', identifierKeyed: true },
      // Generic secrets/passwords/tokens in assignments
      { regex: /(?:secret|password|passwd|pwd|token|auth_token|access_token|refresh_token|client_secret)\s*[:=]\s*['"][a-zA-Z0-9_\-/.+]{8,}['"]/gi, name: 'Hardcoded Secret/Password/Token', identifierKeyed: true },
      // High-entropy hex strings assigned to suspicious variable names
      { regex: /(?:secret|key|token|password|credential|auth)\s*[:=]\s*['"][0-9a-fA-F]{32,}['"]/gi, name: 'High-Entropy Hex String', identifierKeyed: true },
      // High-entropy base64 strings assigned to suspicious variable names
      { regex: /(?:secret|key|token|password|credential|auth)\s*[:=]\s*['"][A-Za-z0-9+/]{32,}={0,2}['"]/gi, name: 'High-Entropy Base64 String', identifierKeyed: true },
    ];

    // Two kinds of pattern above, and they must be told apart (secrets.js
    // draws the same line). VENDOR-SHAPED — AKIA…, ghp_…, a JWT, a PEM — is
    // a credential wherever it sits; a test file does not make an AWS key
    // fake. IDENTIFIER-KEYED — `password = "…"` — matches on the NAME, and
    // the name is exactly what test fixtures are full of: django @b3f4d83
    // produced 76 blocking "secrets", 74 of them `password='secret'`-shaped
    // fixtures under tests/. Those drop to warning in test trees.
    //
    // A value that itself NAMES a credential is a label, not a credential:
    //   INTERNAL_RESET_SESSION_TOKEN = "_password_reset_token"
    //   reset_url_token = "set-password"
    // were Django's other two. Nobody's secret is the word "password".
    // "Names a credential" is a SHAPE, not a substring: snake/kebab case,
    // no digits, and either the bare word (`"secret"`, what Django's
    // fixtures use) or a separator on either side (`_password_reset_token`,
    // `set-password`). `mysecretkey2024` and `secretpass1` are values that
    // happen to contain the word, and they still fire — the first cut of
    // this rule skipped them, which is the recall hole this comment guards.
    const CREDENTIAL_WORD = 'password|passwd|secret|token|api[_-]?key|credential';
    const LABEL_RE = new RegExp(
      `^(?:${CREDENTIAL_WORD})$|^[a-z]*[_-][a-z_-]*(?:${CREDENTIAL_WORD})[a-z_-]*$|^[a-z_-]*(?:${CREDENTIAL_WORD})[a-z_-]*[_-][a-z_-]*$`, 'i');
    const labelValue = (matched) => {
      const q = matched.match(/['"]([^'"]*)['"]\s*$/);
      return q ? LABEL_RE.test(q[1]) : false;
    };

    let totalFindings = 0;

    for (const file of files) {
      const relPath = repoRelative(projectRoot, file);
      const isTestFile = typeof this._isTestPath === 'function' && this._isTestPath(relPath);
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
      // Regex-literal context for the JS family (the one stripper that knows
      // a regex from a string): `/AKIA[0-9A-Z]{16}/` in a pattern table is a
      // description of a key's shape, not a key.
      const masked = /\.(?:[cm]?js|jsx|tsx?)$/i.test(basename) ? this._maskedLines(content, relPath) : null;

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
            if (connectionStringIsDevDefault(match[0])) continue;
            if (pattern.identifierKeyed && labelValue(match[0])) continue;
            // AWS documents `AKIAIOSFODNN7EXAMPLE` as THE key to write in
            // docs; it authenticates nothing anywhere. secrets.js already
            // knew that (PUBLISHED_EXAMPLE_CREDENTIALS) — this rule reported
            // that module's own copy of the list and blocked this repo's
            // full suite (src/modules/secrets.js:166, 2026-09-14).
            if (PUBLISHED_EXAMPLE_CREDENTIALS.has(match[0])) continue;
            // The source of a regex literal describes a shape; it is not a
            // value. Same column on the raw line — the mask is length-
            // preserving.
            if (masked && literalKindAt(lines, masked, i, match.index) === 'regex') continue;
            // `'jwtSecret' in options` — the quoted text is a property NAME
            // being tested for, not a value being assigned (prisma
            // packages/3-extensions/supabase/src/runtime/supabase.ts:183).
            if (pattern.identifierKeyed && /^\s+in\b/.test(maskedLine.slice(match.index + match[0].length))) continue;
            // Algolia DocSearch config — `algolia: { appId, apiKey, indexName }`
            // in a Docusaurus site. That apiKey is the SEARCH-ONLY key Algolia
            // tells you to commit; every DocSearch site ships it in the
            // browser bundle (trpc www/docusaurus.config.ts:48). Only the
            // `apiKey` inside a block that opens with `algolia:` is exempt.
            if (pattern.identifierKeyed && /\bapi[_-]?key\s*[:=]/i.test(line)
              && lines.slice(Math.max(0, i - 6), i + 1).some((l) => /\balgolia\s*[:=]\s*\{/.test(l))) continue;
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
              ...(pattern.identifierKeyed && isTestFile ? { severity: 'warning' } : {}),
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
      // A rollup has no file, so the confidence layer scores it at 1.0 —
      // which let it BLOCK on findings the same layer had already judged
      // too weak to block (one soft 0.40 finding in src/modules/ took the
      // full suite red, 2026-09-14). The rollup is a count, not new
      // evidence: it inherits the confidence of its most confident live
      // constituent, so it can never block harder than the findings it
      // summarises. (A bare stub result in unit tests carries no
      // confidence; then the default stands, as before.)
      const inherited = this._maxLiveConfidence(result, 'security:secret:');
      result.addCheck('security:secrets-scan', false, {
        message: `Found ${reported} potential secret(s) across scanned files`,
        suggestion: 'Review all findings and move secrets to environment variables or a secrets manager',
        ...(typeof inherited === 'number' ? { confidence: inherited } : {}),
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
          const rel = repoRelative(projectRoot, f);
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
        } catch { /* error-ok — unreadable dependency package.json — its license is not classified */ }
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
    } catch { /* error-ok — unreadable package.json — the syntax module reports it; no license check */ }
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
