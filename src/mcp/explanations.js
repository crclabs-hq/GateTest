/**
 * gatetest_explain_check — knowledge base.
 *
 * Maps known module / check-shape pairs to structured explanations that an
 * AI agent can use to (a) tell a human what a finding means and (b) write
 * the fix without having to grep our source.
 *
 * Schema (per entry):
 *   {
 *     module:      string  - module name (matches BUILT_IN_MODULES key)
 *     checkId:     string  - check-name pattern (e.g. "js-reject-unauthorized")
 *     severity:    string  - "error" | "warning" | "info"
 *     whatItMeans: string  - one sentence
 *     whyItMatters: string - the real-world consequence
 *     exampleBad:  string  - tiny code snippet that triggers the rule
 *     exampleGood: string  - the fix shape
 *     fixSteps:    string[] - imperative bullet list
 *     suppressionMarker: string | null - if intentional, the inline comment
 *     learnMore:   string  - CWE / OWASP / vendor doc reference
 *   }
 *
 * Coverage philosophy: depth on the security-critical rules first
 * (TLS / cookies / log-PII / SSRF / ReDoS / hardcoded URLs / Stripe replay /
 * race conditions / N+1 / retry hygiene / homoglyph), then breadth.
 *
 * A generic fallback handles unknown check IDs by composing from the
 * module's description.
 */

const EXPLANATIONS = [
  // ---- tlsSecurity ----------------------------------------------------
  {
    module: 'tlsSecurity',
    checkId: 'js-reject-unauthorized',
    severity: 'error',
    whatItMeans:
      'A Node.js HTTPS / TLS call has `rejectUnauthorized: false`, which disables certificate validation.',
    whyItMatters:
      'The connection silently accepts any certificate — including a malicious one from a MITM attacker. Credentials, tokens, and request bodies sent over this socket can be intercepted and modified.',
    exampleBad:
      "const agent = new https.Agent({ rejectUnauthorized: false });\nfetch(url, { agent });",
    exampleGood:
      "// Default: validates the cert chain against the system trust store.\nfetch(url);",
    fixSteps: [
      'Remove `rejectUnauthorized: false` from every https.Agent / tls.connect call.',
      'If you genuinely need to talk to a self-signed staging server, add ONLY that server\'s CA to a custom `ca` array: `new https.Agent({ ca: [stagingCa] })`.',
      'Never set NODE_TLS_REJECT_UNAUTHORIZED=0 — it disables validation process-wide.',
      'Audit deployment env vars to confirm NODE_TLS_REJECT_UNAUTHORIZED is not set anywhere.',
    ],
    suppressionMarker: '// tls-ok',
    learnMore: 'CWE-295 (Improper Certificate Validation), OWASP A02:2021 — Cryptographic Failures.',
  },
  {
    module: 'tlsSecurity',
    checkId: 'js-env-bypass',
    severity: 'error',
    whatItMeans:
      '`process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` is set somewhere in the code, disabling TLS validation for the entire Node process.',
    whyItMatters:
      'This is the nuclear option — every outbound HTTPS request from this process accepts forged certs. It usually gets added "just for staging" and ships to prod.',
    exampleBad: 'process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";',
    exampleGood:
      '// Use a scoped https.Agent with `ca:` for the specific staging host instead.',
    fixSteps: [
      'Remove the assignment.',
      'If staging requires a custom CA, configure it on the specific Agent / fetch call only.',
      'Grep the deployment env for `NODE_TLS_REJECT_UNAUTHORIZED` and remove it.',
    ],
    suppressionMarker: '// tls-ok',
    learnMore: 'Node.js docs — TLS warnings; CWE-295.',
  },
  {
    module: 'tlsSecurity',
    checkId: 'py-verify-false',
    severity: 'error',
    whatItMeans:
      'A Python HTTP call has `verify=False` (or `verify_ssl=False` / `ssl=False`), disabling cert validation.',
    whyItMatters:
      'Same MITM vulnerability as the Node equivalent — every request through this client trusts forged certs.',
    exampleBad: 'requests.get(url, verify=False)',
    exampleGood:
      "# Default: verify against the system CA bundle.\nrequests.get(url)\n# For staging self-signed: requests.get(url, verify='/path/to/staging-ca.pem')",
    fixSteps: [
      'Remove `verify=False` from every requests / httpx / aiohttp call.',
      'For staging self-signed certs, point `verify=` to the staging CA file.',
      'Remove any `urllib3.disable_warnings(InsecureRequestWarning)` calls — they hide the smoke.',
    ],
    suppressionMarker: '# tls-ok',
    learnMore: 'CWE-295; Python `requests` docs — "SSL Cert Verification".',
  },

  // ---- cookieSecurity -------------------------------------------------
  {
    module: 'cookieSecurity',
    checkId: 'js-httponly-false',
    severity: 'error',
    whatItMeans:
      'A cookie or session option has `httpOnly: false`, making the cookie readable from `document.cookie` in the browser.',
    whyItMatters:
      'If you also have an XSS bug anywhere on the site, the attacker can read the session cookie and impersonate the user. HttpOnly is the single line that turns "XSS" into "limited XSS" instead of "full account takeover".',
    exampleBad: "res.cookie('sid', token, { httpOnly: false });",
    exampleGood: "res.cookie('sid', token, { httpOnly: true, secure: true, sameSite: 'lax' });",
    fixSteps: [
      'Set httpOnly: true on every session cookie.',
      'Also set secure: true so cookies never travel over plain HTTP.',
      'Set sameSite: "lax" (or "strict") to defeat most CSRF.',
    ],
    suppressionMarker: '// cookie-ok',
    learnMore: 'OWASP — Session Management; CWE-1004.',
  },
  {
    module: 'cookieSecurity',
    checkId: 'js-weak-secret',
    severity: 'error',
    whatItMeans:
      'A session secret is set to a known weak / placeholder value like "changeme", "keyboard cat", or "your-secret-here".',
    whyItMatters:
      'Anyone who reads the source — including the public GitHub mirror — can forge session cookies and impersonate users.',
    exampleBad: "session({ secret: 'changeme' })",
    exampleGood: "session({ secret: process.env.SESSION_SECRET })",
    fixSteps: [
      'Generate a strong secret: `openssl rand -hex 32`.',
      'Move it to an env var (SESSION_SECRET or similar).',
      'Read it via `process.env.SESSION_SECRET` — never inline.',
      'Document the env var in `.env.example` with an empty value.',
    ],
    suppressionMarker: '// cookie-ok',
    learnMore: 'CWE-798 (Use of Hard-coded Credentials).',
  },

  // ---- ssrf -----------------------------------------------------------
  {
    module: 'ssrf',
    checkId: 'cloud-metadata',
    severity: 'error',
    whatItMeans:
      'Code references a cloud metadata endpoint (AWS 169.254.169.254, GCP metadata.google.internal, Azure metadata.azure.com, Alibaba 100.100.100.200) without an allowlist guard.',
    whyItMatters:
      'If user-controlled input ever reaches this URL builder, the attacker can read IAM credentials, instance metadata, and cloud-init scripts. This is the Capital One breach pattern.',
    exampleBad: "fetch(`http://${userInput}/latest/meta-data/iam/`);",
    exampleGood:
      'const ALLOWED_HOSTS = new Set(["api.example.com"]);\nconst host = new URL(input).hostname;\nif (!ALLOWED_HOSTS.has(host)) throw new Error("blocked");',
    fixSteps: [
      'Never construct outbound URLs from raw user input.',
      'If you must fetch user-provided URLs, validate the hostname against an explicit allowlist.',
      'Block link-local (169.254/16), loopback (127/8), and private (10/8, 172.16/12, 192.168/16) ranges with an SSRF library like `ssrf-req-filter` or `request-filtering-agent`.',
      'Make outbound requests through a proxy that enforces the allowlist at the network layer (defense in depth).',
    ],
    suppressionMarker: null,
    learnMore: 'CWE-918 (SSRF), OWASP A10:2021. Capital One 2019 breach.',
  },
  {
    module: 'ssrf',
    checkId: 'tainted-url',
    severity: 'error',
    whatItMeans:
      'A value from req.body / req.query / req.params / ctx.request reaches fetch / axios / got / http.request without any visible validation.',
    whyItMatters:
      'Attacker can pivot through your server to scan your internal network, read metadata endpoints, or hit admin interfaces that trust internal IPs.',
    exampleBad: 'await fetch(req.body.webhookUrl);',
    exampleGood:
      'const url = new URL(req.body.webhookUrl);\nif (!ALLOWED_HOSTS.has(url.hostname)) throw new Error("blocked");\nawait fetch(url);',
    fixSteps: [
      'Parse the URL and check the hostname against an allowlist before fetching.',
      'Reject any input where new URL() throws.',
      'Treat 30x responses as the same risk — disable redirect-following or re-validate each hop.',
    ],
    suppressionMarker: null,
    learnMore: 'CWE-918, OWASP API8:2023.',
  },

  // ---- redos ----------------------------------------------------------
  {
    module: 'redos',
    checkId: 'nested-quantifier',
    severity: 'error',
    whatItMeans:
      'A regex has a nested quantifier on an element that can itself match empty or has its own quantifier — `(a+)+`, `(.*)*`, `(?:[abc]+)*`.',
    whyItMatters:
      'Crafted input can take exponential time to match. Single regex call → process pinned at 100% CPU for minutes → DoS. Cloudflare 2019 outage was caused by this exact pattern.',
    exampleBad: '/^(a+)+$/.test(input)',
    exampleGood:
      '/^a+$/.test(input)  // flatten the nested quantifier\n// OR use a hard length cap before matching:\nif (input.length > 200) return false;',
    fixSteps: [
      'Rewrite to remove the nested quantifier.',
      'For untrusted input, cap length BEFORE regex matching (typically 200-1000 chars).',
      'Use a regex engine with linear-time guarantees (re2, hyperscan) for parsing user input.',
      'Run `recheck` locally to validate the pattern is safe.',
    ],
    suppressionMarker: '// redos-ok',
    learnMore: 'CWE-1333; Cloudflare 2019 outage postmortem.',
  },

  // ---- logPii ---------------------------------------------------------
  {
    module: 'logPii',
    checkId: 'sensitive-arg',
    severity: 'error',
    whatItMeans:
      'A logger call passes a bare sensitive-named identifier (password, token, apiKey, secret, jwt, etc.) — its value lands in logs in plaintext.',
    whyItMatters:
      'Logs are replicated, archived, ingested by SIEMs, shipped to third parties. Once a credential hits a log line you have to assume it leaked. Facebook 2019 (600M plaintext passwords), Twitter 2018 (330M), Robinhood 2019 — same pattern.',
    exampleBad: 'console.log(password);',
    exampleGood:
      'console.log("auth attempt", { user: userId });  // never the credential itself',
    fixSteps: [
      'Remove the bare sensitive identifier from the log call.',
      'Log a non-sensitive correlation key instead (user ID, request ID).',
      'If you must log a token for debugging, log only the first 6 chars + length.',
      'Rotate any credential that may have hit logs.',
    ],
    suppressionMarker: '// log-safe',
    learnMore: 'CWE-532; GDPR Art. 32; PCI-DSS 3.4.',
  },
  {
    module: 'logPii',
    checkId: 'object-dump',
    severity: 'warning',
    whatItMeans:
      'A logger call passes a bare object identifier (req, request, body, user, headers, cookies) — every field including any embedded credentials hits the log.',
    whyItMatters:
      'Same as sensitive-arg, but worse: you don\'t know what\'s in the object. If a future request gains a `password` field nobody notices the regression.',
    exampleBad: 'logger.info(req.body);',
    exampleGood:
      'logger.info({ event: "request", requestId, path: req.path });  // only the safe shape',
    fixSteps: [
      'Replace the object dump with an explicit allowlist of fields.',
      'If you need the full object for debugging, gate it on NODE_ENV=development.',
    ],
    suppressionMarker: '// log-safe',
    learnMore: 'CWE-532, OWASP Logging Cheat Sheet.',
  },

  // ---- hardcodedUrl ---------------------------------------------------
  {
    module: 'hardcodedUrl',
    checkId: 'localhost',
    severity: 'error',
    whatItMeans:
      'A string literal embeds `localhost` / `127.0.0.1` / `0.0.0.0` and no dev-context guard is visible.',
    whyItMatters:
      'In production, this URL points at the wrong host — either a broken request to the prod machine\'s own localhost, or a leaked hint that something internal was meant. Typical bug: works on dev, silently fails in staging.',
    exampleBad: 'const apiUrl = "http://localhost:3000/api";',
    exampleGood:
      'const apiUrl = process.env.API_URL || "http://localhost:3000/api";',
    fixSteps: [
      'Move the host to an env var with a localhost default.',
      'Document the var in .env.example.',
      'If this is a remote-execution command (SSH + curl localhost on the target), add `// hardcoded-url-ok` with a brief reason.',
    ],
    suppressionMarker: '// hardcoded-url-ok',
    learnMore: '12-factor: III. Config.',
  },

  // ---- raceCondition --------------------------------------------------
  {
    module: 'raceCondition',
    checkId: 'toctou-fs',
    severity: 'error',
    whatItMeans:
      'A filesystem check-then-act pattern: `fs.existsSync` / `fs.stat` followed by `fs.unlink` / `fs.rename` / `fs.chmod` on the same path. The state can change between the check and the act.',
    whyItMatters:
      'TOCTOU (Time-of-check Time-of-use) is the textbook symlink-race vulnerability. Attacker swaps the file with a symlink to /etc/passwd between your check and your action. Local-priv-esc primitive.',
    exampleBad:
      'if (fs.existsSync(p)) fs.unlinkSync(p);',
    exampleGood:
      "try { fs.unlinkSync(p); } catch (err) {\n  if (err.code !== 'ENOENT') throw err;\n}",
    fixSteps: [
      'Drop the existsSync / stat check entirely.',
      'Perform the operation and catch ENOENT (or equivalent) — atomic.',
      'For renames / writes, use `O_EXCL` flags so the call fails atomically if the target exists.',
    ],
    suppressionMarker: null,
    learnMore: 'CWE-367; Linux man fopen(3) — `e` and `x` flags.',
  },

  // ---- nPlusOne -------------------------------------------------------
  {
    module: 'nPlusOne',
    checkId: 'query-in-loop',
    severity: 'error',
    whatItMeans:
      'A database query is awaited inside a loop body — for each iteration the DB round-trips.',
    whyItMatters:
      'A list of 100 items triggers 100 separate queries instead of 1. Latency = 100 × roundtrip. Common cause of "site got slower with more data."',
    exampleBad:
      'for (const user of users) {\n  user.posts = await db.post.findMany({ where: { userId: user.id } });\n}',
    exampleGood:
      "// 1 query: select all posts, group in memory.\nconst posts = await db.post.findMany({ where: { userId: { in: users.map(u => u.id) } } });\n// Or use the ORM's include / join syntax.",
    fixSteps: [
      'Hoist the query out of the loop.',
      'Use the ORM\'s eager-load / include / join feature (Prisma `include`, Sequelize `include`, TypeORM `relations`).',
      'For raw SQL, use `IN (...)` with a batch of IDs.',
      'If parallelism is acceptable, wrap with `Promise.all(arr.map(...))` — the module recognises this as info-level "batched-ok".',
    ],
    suppressionMarker: null,
    learnMore: 'Prisma docs — "Solve the n+1 problem".',
  },

  // ---- retryHygiene ---------------------------------------------------
  {
    module: 'retryHygiene',
    checkId: 'unbounded-loop',
    severity: 'error',
    whatItMeans:
      'A `while (true)` / `for (;;)` retry loop has no `break` / max-attempts guard.',
    whyItMatters:
      'On persistent upstream failure the loop spins forever — CPU pinned, the surrounding request hangs, eventually Vercel/your runtime kills the function. Real-world incidents: every team that has written a retry once has shipped this bug once.',
    exampleBad: 'while (true) { try { return await fetch(url); } catch {} }',
    exampleGood:
      'for (let i = 0; i < 5; i++) { try { return await fetch(url); } catch (err) { if (i === 4) throw err; } }',
    fixSteps: [
      'Add a max-attempts counter.',
      'Add exponential backoff with jitter between attempts.',
      'Bail out on 4xx — those won\'t get better with retries.',
      'Prefer a battle-tested library: `async-retry`, `p-retry`, `cockatiel`.',
    ],
    suppressionMarker: null,
    learnMore: 'AWS Architecture Blog — "Exponential Backoff And Jitter".',
  },

  // ---- importCycle ----------------------------------------------------
  {
    module: 'importCycle',
    checkId: 'cycle',
    severity: 'error',
    whatItMeans:
      'Two or more modules import each other (directly or transitively), forming a cycle in the import graph.',
    whyItMatters:
      'At runtime, one of the modules sees `undefined` for the exports from the other (Temporal Dead Zone in ES modules; partial exports in CommonJS). Bug reproduces randomly depending on test order, hot-reload state, module-cache warmth. Always a refactor to fix.',
    exampleBad:
      "// a.js\nimport { b } from './b';\nexport const a = b + 1;\n// b.js\nimport { a } from './a';  // ← cycle\nexport const b = a + 1;",
    exampleGood:
      "// Move the shared thing to c.js and import from there in both.",
    fixSteps: [
      'Identify the shared concept and extract it to a new file.',
      'Both old files import from the new shared file. No back-references.',
      'If the cycle is between a runtime module and a type-only module, convert the type-side imports to `import type { ... }` (erased at build).',
      'Lazy-require inside a function works as an escape hatch but masks the design problem.',
    ],
    suppressionMarker: '// import-cycle-ok',
    learnMore: 'Webpack docs — "Circular dependencies"; Node.js docs — "Cycles".',
  },

  // ---- moneyFloat -----------------------------------------------------
  {
    module: 'moneyFloat',
    checkId: 'js-parse-float',
    severity: 'error',
    whatItMeans:
      'A money-named variable (price, total, amount, tax, fee, balance, USD, EUR, etc.) is assigned from `parseFloat(...)` or `Number(...)`.',
    whyItMatters:
      'IEEE-754 doubles lose precision on decimal arithmetic. `0.10 + 0.20 !== 0.30`. A $0.01 fee accrued over a million transactions drifts by hundreds of dollars. Regulators call this fraud.',
    exampleBad: 'const total = parseFloat(req.body.total);',
    exampleGood:
      "import { Decimal } from 'decimal.js';\nconst total = new Decimal(req.body.total);",
    fixSteps: [
      'Install a decimal library: `decimal.js`, `big.js`, `dinero.js`, or `currency.js`.',
      'Replace `parseFloat(money)` with `new Decimal(money)` and propagate the type.',
      'Store money in integers (cents) at the DB layer.',
      'On display, convert to string with the library\'s `.toFixed(2)` — not the native JS one.',
    ],
    suppressionMarker: '// money-float-ok',
    learnMore: 'Martin Fowler — "Money pattern"; IEEE-754 spec.',
  },

  // ---- homoglyph ------------------------------------------------------
  {
    module: 'homoglyph',
    checkId: 'bidi',
    severity: 'error',
    whatItMeans:
      'A source file contains Unicode bidirectional-override or isolate characters (U+202A..U+202E, U+2066..U+2069).',
    whyItMatters:
      'CVE-2021-42574 ("Trojan Source"). These characters reorder how source displays in editors / code review tools without changing what the compiler sees. An attacker can hide malicious code in a PR that looks innocent.',
    exampleBad: '// Looks like: access_level = "user";\n// Compiler sees: access_level = "admin";\n// Because hidden U+202E characters flipped the displayed bytes.',
    exampleGood: '// Use only printable ASCII / standard Unicode in identifiers.',
    fixSteps: [
      'Remove every bidirectional-override character from source.',
      'Configure your editor to render U+202A..U+202E / U+2066..U+2069 visibly (most modern editors do this automatically since 2021).',
      'Add a pre-commit check that rejects these characters.',
      'GitHub now warns on these in diff views — read the warning, don\'t dismiss.',
    ],
    suppressionMarker: null,
    learnMore: 'CVE-2021-42574 — "Trojan Source"; trojansource.codes.',
  },

  // ---- errorSwallow ---------------------------------------------------
  {
    module: 'errorSwallow',
    checkId: 'empty-catch',
    severity: 'error',
    whatItMeans:
      'A `try { ... } catch {}` block has no body — every exception that flows through is silently discarded.',
    whyItMatters:
      'You lose visibility into real bugs. The first you hear about the problem is when a downstream system fails because of corrupted state that the swallowed exception should have prevented.',
    exampleBad: 'try { JSON.parse(data); } catch {}',
    exampleGood:
      "try { JSON.parse(data); } catch (err) {\n  logger.warn('Failed to parse incoming data', { err: err.message });\n  // re-throw or return a default — never silent.\n}",
    fixSteps: [
      'Log the error with context.',
      'Decide explicitly: re-throw, return default, or recover. Document which.',
      'If the swallow is intentional (best-effort cleanup, idempotent retry, etc.) add `// error-swallow-ok` with a one-line rationale.',
    ],
    suppressionMarker: '// error-swallow-ok',
    learnMore: 'Clean Code (Martin) — "Don\'t Return Null"; Effective Java — Item 77.',
  },
];

const EXPLANATIONS_BY_KEY = (() => {
  const map = new Map();
  for (const e of EXPLANATIONS) {
    map.set(`${e.module}:${e.checkId}`, e);
  }
  return map;
})();

const EXPLANATIONS_BY_MODULE = (() => {
  const map = new Map();
  for (const e of EXPLANATIONS) {
    if (!map.has(e.module)) map.set(e.module, []);
    map.get(e.module).push(e);
  }
  return map;
})();

/**
 * Look up an explanation. Returns the structured entry, OR a generic
 * fallback that composes from the module description so callers always
 * get a useful answer.
 */
function explainCheck(moduleName, checkId, moduleRegistry) {
  if (typeof moduleName !== 'string' || moduleName.length === 0) {
    throw new Error('moduleName is required');
  }

  // Full match?
  if (checkId) {
    const direct = EXPLANATIONS_BY_KEY.get(`${moduleName}:${checkId}`);
    if (direct) {
      return { match: 'exact', explanation: direct };
    }
    // Partial: try matching checkId against any registered entry for this module.
    const candidates = EXPLANATIONS_BY_MODULE.get(moduleName) || [];
    for (const e of candidates) {
      if (checkId.includes(e.checkId) || e.checkId.includes(checkId)) {
        return { match: 'partial', explanation: e };
      }
    }
  }

  // Module-level: return every explanation we have for this module.
  const all = EXPLANATIONS_BY_MODULE.get(moduleName);
  if (all && all.length > 0) {
    return { match: 'module', explanations: all };
  }

  // Generic fallback. Pull the description off the module instance if we
  // can — that way every one of our 67 modules returns something useful.
  const description =
    (moduleRegistry &&
      moduleRegistry.get &&
      moduleRegistry.get(moduleName) &&
      moduleRegistry.get(moduleName).description) ||
    null;

  if (description) {
    return {
      match: 'generic',
      explanation: {
        module: moduleName,
        checkId: checkId || '(any)',
        severity: 'unknown',
        whatItMeans: description,
        whyItMatters:
          'No structured explanation is registered for this specific check ID yet. ' +
          'The module description above describes what the rule family catches.',
        exampleBad: null,
        exampleGood: null,
        fixSteps: [
          `Inspect the module source at src/modules/${moduleName.replace(/([A-Z])/g, '-$1').toLowerCase()}.js (or similar) to see the exact pattern.`,
          'Open an issue / contribute a structured explanation entry so future agents get a better answer.',
        ],
        suppressionMarker: null,
        learnMore: null,
      },
    };
  }

  throw new Error(
    `Unknown module: ${moduleName}. Call gatetest_list_modules for the catalog.`,
  );
}

module.exports = {
  EXPLANATIONS,
  EXPLANATIONS_BY_KEY,
  EXPLANATIONS_BY_MODULE,
  explainCheck,
};
