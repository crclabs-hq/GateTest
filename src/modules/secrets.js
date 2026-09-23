/**
 * Secrets Module - Scans for hardcoded secrets, API keys, tokens, and passwords.
 * Zero tolerance for secrets in source code or git history.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
const { WALK_EXCLUDES } = require('../core/walk-excludes');
const { literalKindAt } = require('../core/source-strip');

/**
 * Values that ANNOUNCE they are not credentials.
 *
 * This regex existed twice, character-for-character, with a comment above one
 * copy reading "rather than duplicating the placeholder list — one definition,
 * one behaviour". The two copies had already diverged: one carried the `i`
 * flag and one did not, so `CHANGEME` was suppressed on the env-fallback path
 * and reported on the main scan path. A comment asserting single-sourcing is
 * not single-sourcing.
 *
 * `<...>` was added 2026-09-01 when documentation files were brought into
 * scope. Angle brackets are THE convention for a fill-this-in slot, and
 * NodeGoat's README carries the canonical example:
 *
 *     mongodb://<username>:<password>@<cluster>/<dbname>?ssl=true
 *
 * which the Database-URL rule matched. Without this, switching on docs
 * scanning traded a false negative for a false positive.
 */
// An ELIDED value cannot be a working credential. Documentation redacts by
// truncation — `sk_test_51...`, `sk-ant-api03-...`, `MIIE...` — and
// docs/ops/GO_LIVE_RUNBOOK.md was reported as a committed secret at ERROR
// severity for a table of exactly those examples. Every customer with a
// setup runbook has the same table.
//
// Three dots or more, never one or two: a JWT is `header.payload.signature`
// and a real key can contain a dot, so `\.{3,}` is the line between a
// truncation mark and ordinary punctuation.
const PLACEHOLDER_VALUE_RE = /(?:changeme|placeholder|your[_-]?(?:\w+[_-])?(?:secret|key|password|token)|replace[_-]?me|(?<![a-z0-9])example(?![a-z0-9])|default[_-]?(?:secret|key|password|token)|xxx+|insert[_-]?here|todo|<[a-z0-9_. -]{2,30}>|\.{3,}|\u2026)/i;

/**
 * A Database-URL match is a CREDENTIAL only when it carries one.
 *
 * Measured 2026-09-05 on four third-party repos (corpus6): every blocking
 * Database-URL finding was one of three shapes, none of them a secret \u2014
 *
 *   nestjs/nest   integration/mongoose/src/app.module.ts:7
 *       MongooseModule.forRoot('mongodb://localhost:27017/test')
 *   prisma        packages/1-framework/3-tooling/cli/scripts/record.ts:171
 *       const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5433/postgres'
 *   prisma        packages/3-extensions/mongo/src/runtime/binding.ts:122
 *       '... (e.g. mongodb://host:27017/mydb), or pass dbName explicitly'
 *
 * A URL with no userinfo names a LOCATION. On a loopback host that location
 * is the developer's own machine and discloses nothing; a placeholder host
 * (`host`, `example.com`) is documentation. A URL whose password is the word
 * `password` / `pass` / `PASS` is a template, and `postgres:postgres` on
 * loopback is the Docker image default that no one chose.
 *
 * Deliberately NOT suppressed, and pinned by the NodeGoat recall floor: a
 * credential-less URL to a NAMED host (`mongodb://mongo:27017/nodegoat` in
 * docker-compose.yml \u2014 that host name is topology), a real password on any
 * host including loopback, and `user==pass` on a non-loopback host.
 */
const DB_URL_PARTS_RE = /^[a-z][a-z0-9+.-]*:\/\/(?:([^:@/?#]*)(?::([^@/?#]*))?@)?(\[[^\]]+\]|[^:/?#]+)/i;
const LOOPBACK_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|::1)$/i;
const PLACEHOLDER_HOST_RE = /^(?:host|hostname|server|db[-_]?host|your[-_]?host|my[-_]?host|(?:[a-z0-9-]+\.)*example\.(?:com|org|net))$/i;
const PLACEHOLDER_CREDENTIAL_RE = /^(?:user|username|pass|password|passwd|pwd)$/i;

/**
 * Keys a vendor DESIGNS to ship in a client bundle are public by contract,
 * not leaked. Stripe publishable keys announce it in the prefix. Algolia
 * DocSearch keys do not \u2014 they are 32 hex chars like any other Algolia key \u2014
 * so those are recognised only inside an `algolia:` / `docsearch` block
 * that says nothing about `admin` or `write`:
 *
 *   trpc/trpc  www/docusaurus.config.ts:48
 *       algolia: { appId: 'BTGPSR4MOE', apiKey: 'ed8b3896f8e3e2b421e4c38834b915a8', indexName: 'trpc' }
 *
 * Docusaurus's own template comments that line "Public API key: it is safe
 * to commit it". A search-only key cannot read, write or list indices.
 */
const PUBLISHABLE_KEY_RE = /^pk_(?:live|test)_[A-Za-z0-9]+$/;
const ALGOLIA_KEY_RE = /^[a-f0-9]{32}$/;
const SEARCH_CONFIG_WINDOW = 6;

/**
 * Files whose whole purpose is to hold key material. The line-pattern loop
 * is wrong for them \u2014 a PEM body is base64, and a 200 KB CA bundle is 3,000
 * lines of it \u2014 so they are classified by their header instead:
 * private key material, recognisably public (a certificate, a public key,
 * a CSR), or unknown.
 *
 * Until 2026-09-05 the module never opened these at all. OWASP NodeGoat's
 * committed `artifacts/cert/server.key` \u2014 a real RSA private key \u2014 was only
 * ever reported as ".gitignore missing pattern: *.key", which names the
 * wrong defendant: adding the line would not un-commit the key.
 */
// A directory segment that is a fixture/example/mock dir, or a basename in
// which fixture/example/mock is a whole token (`.env.example`, `fixture.key`,
// `user.mock.ts`, `MockServer.ts`) — never a substring of a longer word.
// No `i` flag: with it `[A-Z]` matches lowercase and `mockingbird` is a mock.
const FIXTURE_PATH_RE = /(?:^|\/)(?:__fixtures__|[Ff]ixtures?|[Ee]xamples?|[Ss]amples?|__mocks__|[Mm]ocks?)(?:\/|$)|(?:^|\/)[^/]*(?:^|[._-]|\b)(?:[Ff]ixture|[Ee]xample|[Mm]ock)s?(?=[._-]|[A-Z]|$)[^/]*$/;
const KEY_FILE_EXTENSIONS = new Set(['.pem', '.key', '.p8', '.pk8', '.ppk']);
const KEY_FILE_HEAD_BYTES = 64 * 1024;
const PRIVATE_KEY_HEADER_RE = /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY(?: BLOCK)?-----|^PuTTY-User-Key-File-\d/m;
const PUBLIC_PEM_HEADER_RE = /-----BEGIN (?:(?:TRUSTED |X509 )?CERTIFICATE|PUBLIC KEY|CERTIFICATE REQUEST|NEW CERTIFICATE REQUEST|X509 CRL)-----/;

/**
 * Credential types recognisable from the VALUE alone.
 *
 * These carry a vendor prefix or a structural header — `AKIA…`, `sk_live_…`,
 * `ghp_…`, `-----BEGIN … PRIVATE KEY-----`. Nobody writes one to illustrate a
 * concept, so finding one in a README means a key is in the README.
 *
 * Everything else in `this.patterns` keys off the IDENTIFIER (`password`,
 * `api_key`, `token`) and matches any 8+ character value after it. That is
 * exactly what authentication documentation contains, which is why the two
 * groups have to be told apart rather than treated as one "credential rule"
 * family. Measured on axios: nine doc false positives, every one from the
 * identifier-keyed group, none from this one.
 */
const VENDOR_SHAPED_TYPES = new Set([
  'Private Key',
  'GitHub PAT',
  'GitHub OAuth Token',
  'GitHub Fine-Grained Token',
  'OpenAI/Stripe Key',
  'Stripe Live Key',
  'Slack Token',
  'AWS Access Key ID',
]);

/**
 * Where a credential-shaped value is an ILLUSTRATION — a test tree or a
 * documentation file — the question is no longer "does this look like a
 * key" (it does; that is what a fixture is for) but "could this one be
 * live". Fifty-three of this repository's own test files were reported as
 * "potential secret(s)" on 2026-09-13, every one a fixture the test plants
 * on purpose (`apiKey: 'test-key'`, `ghp_AAAA…`, AWS's published example
 * key), and security.js already draws the first half of this line:
 * identifier-keyed matches (`password = "…"`) key off the NAME, and the
 * name is exactly what fixtures are full of.
 *
 * The second half is what a vendor-shaped value cannot be:
 *   - a PUBLISHED example. AWS documents `AKIAIOSFODNN7EXAMPLE` /
 *     `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` as the pair to write in
 *     docs; they authenticate nothing anywhere.
 *   - visibly SYNTHETIC. A run of one character (`ghp_AAAA…`), a short unit
 *     repeated (`ghp_realrealreal…`), or the alphabet / the digits in order
 *     (`ghp_1234567890abcdef…`) is a value typed to have the right length.
 *     Random base62 hits none of these: a six-run is (1/62)^5 per position.
 *   - a PEM header with no key material behind it. `\`-----BEGIN RSA
 *     PRIVATE KEY-----\n${body}\n…\`` and a header alone in an array of
 *     lines carry no bits; a real key has 64-character base64 lines whose
 *     TAIL is random (the openssh / PKCS#8 preambles are constant and DO
 *     contain runs, so only the last 32 characters of a line are judged).
 *
 * Anything that passes those tests in a test tree stays a warning — "a
 * test file does not make an AWS key fake" (security.js). Outside test
 * trees and prose nothing here applies: a synthetic key in src/ is a
 * placeholder someone will replace in place, and stays an error.
 */
const PUBLISHED_EXAMPLE_CREDENTIALS = new Set([
  'AKIAIOSFODNN7EXAMPLE',
  'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
]);
const SYNTHETIC_RUN_RE = /(.)\1{5,}|(.{2,4})\2{3,}/;
const KEY_MATERIAL_RE = /[A-Za-z0-9+/=]{48,}/g;
const SEQUENTIAL_RUN = 8;

/**
 * The identifier-keyed patterns: matched on the NAME (`token = "…"`), any
 * 8+ character value. Everything below applies to these three only — a
 * vendor-shaped value is a credential whatever it is assigned to.
 */
const IDENTIFIER_KEYED_TYPES = new Set(['API Key', 'Password/Secret', 'Token']);

/**
 * RFC 6749's own vocabulary is not a credential (#682, Gluecron):
 *
 *   scripts/doctor.ts:124
 *       const badRefresh = await jpost("/oauth/token",
 *         { grant_type: "refresh_token", refresh_token: "<a real-looking test value>" })
 *
 * `refresh_token`, `authorization_code`, `client_credentials`, `password`,
 * `bearer`, `code` and `token` are the well-known enum values OAuth defines
 * for a `grant_type` / `token_type` / `response_type` field — the STRING
 * naming the flow, never a secret that authenticates anything. A line that
 * names one of those three fields and whose matched value IS one of those
 * seven words, in any case, is a protocol constant beside the credential the
 * line is actually about — not the credential itself.
 */
const OAUTH_ENUM_VALUES = new Set([
  'refresh_token', 'authorization_code', 'client_credentials', 'password', 'bearer', 'code', 'token',
]);
const OAUTH_FIELD_RE = /\b(?:grant_type|token_type|response_type)\s*[:=]/i;

/**
 * A value that NAMES something is not a credential (corpus, 2026-09-14):
 *
 *   django/django  docs/_ext/djangodocs.py:290
 *       token = "make.bat"                       ← a filename
 *   django/django  django/contrib/auth/views.py:262
 *       reset_url_token = "set-password"         ← a URL slug
 *   django/django  django/contrib/auth/views.py:246
 *       INTERNAL_RESET_SESSION_TOKEN = "_password_reset_token"  ← a session key
 *
 * Three files, three blocking "secrets" at confidence 1.0, none of them a
 * value that authenticates anything. security.js already draws the slug
 * line (LABEL_RE: "nobody's secret is the word password"); this module did
 * not, so the same line blocked under `secrets:` after `security:` had
 * learned to let it through.
 *
 * Two shapes, both narrow:
 *   - a FILENAME: one path-safe token ending in a known source, config,
 *     script, document or key-file extension. `make.bat`, `server.key`,
 *     `settings.local.json`. Not a path with slashes, not a sentence.
 *   - a LABEL: two to four lowercase words joined by `-` or `_`, no digits,
 *     one of which is a credential word. `set-password`,
 *     `_password_reset_token`, `old-password`. A slug that does NOT name a
 *     credential (`layova-admin`) is still a weak password and still fires;
 *     so does the bare word (`password: 'password'` — a weak default, pinned
 *     by tests/secrets-corpus6-precision.test.js).
 *
 * Neither shape can suppress a value that LOOKS random. `isCredentialShaped`
 * is the guard: 16+ characters, ≥ 3.5 bits/char of Shannon entropy and a
 * letter/digit mix is what a generated key measures, and no filename or
 * slug rule may quiet one. (Entropy alone cannot tell `set-password` from
 * `hunter2!x` at these lengths — the shape rules carry the decision, the
 * entropy guard bounds them.)
 */
const FILENAME_VALUE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:bat|cmd|sh|bash|zsh|ps1|exe|py|pyc|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|toml|ini|cfg|conf|txt|md|rst|html?|css|scss|xml|csv|tsv|log|env|lock|pem|key|crt|cer|p12|pfx|jks|db|sqlite3?|so|dll|jar|zip|tar|gz|png|jpe?g|gif|svg|ico|woff2?|ttf)$/i;
const LABEL_VALUE_RE = /^[_-]?[a-z]+(?:[_-][a-z]+){1,3}[_-]?$/;
const LABEL_CREDENTIAL_WORD_RE = /(?:^|[_-])(?:password|passwd|secret|token|key|credential|auth)(?:[_-]|$)/;
const CREDENTIAL_SHAPE_MIN_LENGTH = 16;
const CREDENTIAL_SHAPE_MIN_ENTROPY = 3.5;

/** Shannon entropy of `value` in bits per character. */
function shannonEntropy(value) {
  if (!value) return 0;
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Long, high-entropy, mixed letters and digits/base64 — what a generated key measures. */
function isCredentialShaped(value) {
  return value.length >= CREDENTIAL_SHAPE_MIN_LENGTH
    && shannonEntropy(value) >= CREDENTIAL_SHAPE_MIN_ENTROPY
    && /[A-Za-z]/.test(value)
    && /[0-9+/=]/.test(value);
}

/**
 * A doctest line is documentation whatever file it sits in:
 *
 *   django/django  django/template/base.py:746
 *       >>> token = 'variable|default:"Default value"|date:"Y-m-d"'
 *
 * That line is inside a docstring, which the mask below also catches — but
 * `>>>` in a .rst or a README is the same thing, and the prompt is the
 * cheaper, more direct test.
 */
const DOCTEST_LINE_RE = /^\s*(?:>>>|\.\.\.)\s/;

/**
 * Files the source stripper parses well enough to answer "is this line
 * inside a block comment / docstring / regex literal". Everything else
 * (config formats, shell, prose) keeps the line-start comment test only —
 * the line-level fallback stripper cannot see a block that spans lines,
 * and guessing would fail toward silence.
 */
const DOC_CONTEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java']);

/** Eight or more characters each one code point after (or before) the last. */
function hasSequentialRun(value, n = SEQUENTIAL_RUN) {
  let up = 1;
  let down = 1;
  for (let i = 1; i < value.length; i += 1) {
    const d = value.charCodeAt(i) - value.charCodeAt(i - 1);
    up = d === 1 ? up + 1 : 1;
    down = d === -1 ? down + 1 : 1;
    if (up >= n || down >= n) return true;
  }
  return false;
}

class SecretsModule extends BaseModule {
  constructor() {
    super('secrets', 'Secret & Credential Detection');
    this.patterns = [
      { regex: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{8,}/gi, type: 'API Key' },
      { regex: /(?:secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}/gi, type: 'Password/Secret' },
      { regex: /(?:token|bearer)\s*[:=]\s*['"][^'"]{8,}/gi, type: 'Token' },
      { regex: /(?:aws|amazon).{0,20}(?:key|secret|token).{0,20}['"][A-Za-z0-9/+=]{20,}/gi, type: 'AWS Credential' },
      // The header ALONE is not a key. A setup runbook writes
      // `-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END...` in a table to
      // tell an operator what to paste, and docs/ops/GO_LIVE_RUNBOOK.md was
      // reported as a committed private key at ERROR severity for exactly
      // that line. The comment above this list says "nobody writes one to
      // illustrate a concept" — a runbook does, and so does every customer's.
      //
      // The header has to keep matching on its own, because a real .pem has
      // it alone on line one and this scanner reads a line at a time — so
      // "require key material" cannot be the test. What separates a key from
      // a mention is ELISION: `MIIE...` cannot authenticate, and neither a
      // .pem on disk nor a key inlined in source ever carries an ellipsis.
      // `illustrationIfElided` applies that to the LINE, since the ellipsis
      // sits beside the header rather than inside the match.
      { regex: /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY(?: BLOCK)?-----/g, type: 'Private Key', illustrationIfElided: true },
      { regex: /ghp_[A-Za-z0-9_]{36,}/g, type: 'GitHub PAT' },
      { regex: /gho_[A-Za-z0-9_]{36,}/g, type: 'GitHub OAuth Token' },
      { regex: /github_pat_[A-Za-z0-9_]{22,}/g, type: 'GitHub Fine-Grained Token' },
      { regex: /sk-[A-Za-z0-9]{32,}/g, type: 'OpenAI/Stripe Key' },
      { regex: /sk_live_[A-Za-z0-9]{24,}/g, type: 'Stripe Live Key' },
      { regex: /xox[bprs]-[A-Za-z0-9-]{10,}/g, type: 'Slack Token' },
      // A backtick closes a template literal or a Markdown code span the same
      // way a quote closes a string; without it `mongodb://localhost` in a
      // sentence of docs/HISTORY.md read as `localhost\`` — a host that no
      // loopback test could recognise (2026-09-13).
      { regex: /(?:mongodb|postgres|mysql|redis):\/\/[^'"`\s]{10,}/gi, type: 'Database URL' },
      { regex: /AKIA[A-Z0-9]{16}/g, type: 'AWS Access Key ID' },
      { regex: /(?:sendgrid|mailgun|twilio).{0,20}['"][A-Za-z0-9.]{20,}/gi, type: 'Service API Key' },
    ];
  }

  /**
   * True when the quoted value in a `key: 'value'` match reads as English
   * prose rather than a credential.
   *
   * Why this exists: the pattern rules key off the IDENTIFIER (`secret`,
   * `token`, `api_key`), so any object that maps env-var names to
   * human-readable descriptions trips them — a documentation map, not a
   * leak. Found by GateTest's own self-scan on
   * scripts/marketplace-preflight.js (`CRON_SECRET: 'the scan queue is
   * never drained ...'`).
   *
   * The test is deliberately conservative — a value only counts as prose
   * when it has 4+ whitespace-separated words AND contains no contiguous
   * 12-char run mixing letters with digits/`+/=` (the signature of a real
   * key). A multi-word passphrase like `'correct horse battery staple'`
   * is the one shape this could mask, so the token test stays strict and
   * anything with key-like entropy is still reported.
   *
   * @param {string} match - full regex match, e.g. `SECRET: 'some words'`
   * @returns {boolean}
   */
  /**
   * True when the quoted value REFERENCES a secret instead of containing one:
   * a shell expansion, a command substitution, or an interpolation.
   *
   * Why this exists: this exact false positive blocked GateTest's OWN CI for
   * days. `scripts/deploy/tick.sh:34` reads the secret out of a file —
   *
   *   SECRET="$(sed -n 's/^CRON_SECRET=//p' "$ENV_FILE" | head -n1)"
   *
   * — and the `secret\s*[:=]\s*['"]...` rule matched `SECRET="` followed by
   * eight-plus characters. That line is the OPPOSITE of a hardcoded secret:
   * it is the safe pattern we tell customers to use. GATE: BLOCKED on it,
   * which is both a false positive and a Forbidden #25 violation (we must
   * never block our own operators).
   *
   * Deliberately narrow — the value must START with the expansion, so a real
   * credential that merely contains a `$` later is still reported. A secrets
   * module must fail toward detection, never toward silence.
   *
   * @param {string} match - full regex match, e.g. `SECRET="$(cmd)"`
   * @returns {boolean}
   */
  _looksLikeReference(match) {
    // Anchor on the FIRST quote — the one that opens the assignment's value.
    // (_looksLikeProse anchors on the last quote, which is right for its own
    // test but wrong here: on `SECRET="$(sed -n 1p "$ENV_FILE")` the last
    // quote yields `")` and the expansion is missed entirely.)
    // `match` is the secrets regex hit, which always begins at the identifier,
    // so the first quote in it is always the value's opening quote.
    const q = match.match(/['"]([\s\S]*)$/);
    if (!q) return false;
    const value = q[1].trim();
    return (
      value.startsWith('$(')    // POSIX command substitution
      || value.startsWith('${')  // shell / template-literal expansion
      || value.startsWith('`')   // backtick command substitution
      || /^\$[A-Za-z_]/.test(value)      // bare $VAR
      || /^%[A-Za-z_][A-Za-z0-9_]*%/.test(value)  // Windows %VAR%
      || /^process\.env\b/.test(value)   // Node
      || /^os\.environ\b/.test(value)    // Python
      || /^ENV\[/.test(value)            // Ruby
    );
  }

  /**
   * True when a Database-URL match carries no credential worth reporting.
   * See the DB_URL_PARTS_RE comment for the measured shapes and the lines
   * that stay reported.
   *
   * @param {string} url - the matched URL, e.g. `postgres://u:p@h:5432/db`
   * @returns {boolean}
   */
  _databaseUrlIsPlaceholder(url) {
    const parts = url.match(DB_URL_PARTS_RE);
    if (!parts) return false;
    const [, user = '', password = '', host = ''] = parts;
    const loopback = LOOPBACK_HOST_RE.test(host);
    if (!password) {
      // `user@host` with no password is still no credential.
      return loopback || PLACEHOLDER_HOST_RE.test(host);
    }
    if (PLACEHOLDER_VALUE_RE.test(password)) return true;
    if (PLACEHOLDER_CREDENTIAL_RE.test(password)) return true;
    // `postgres:postgres@127.0.0.1` — the image default on the dev machine.
    return loopback && user.toLowerCase() === password.toLowerCase();
  }

  /**
   * True when the quoted value NAMES the thing it is assigned to instead of
   * holding a credential.
   *
   * Two shapes, both from corpus6 (2026-09-05):
   *
   *   nestjs/nest  integration/injector/src/dynamic/dynamic.module.ts:3
   *       export const DYNAMIC_TOKEN = 'DYNAMIC_TOKEN';
   *   prisma       packages/3-extensions/supabase/src/runtime/supabase.ts:183
   *       const jwtSecret = 'jwtSecret' in options ? options.jwtSecret : undefined;
   *
   * The first is a DI injection token whose string value is its own
   * identifier; the second probes for a property. The own-name test requires
   * the value to LOOK like an identifier (an uppercase letter, `_` or `-`):
   * `password: 'password'` is equal to its name too, but it is a weak default
   * credential, not a symbol, and it stays reported.
   *
   * @param {string} scanLine - the neutralised line the pattern ran on
   * @param {RegExpExecArray} m - the identifier-keyed match
   * @returns {boolean}
   */
  _isSelfReferentialValue(scanLine, m) {
    const q = m[0].match(/^([^'"]*?)\s*[:=]\s*['"]([^'"]*)$/);
    if (!q) return false;
    const after = scanLine.slice(m.index + m[0].length);
    if (/^['"]\s+in\s/.test(after)) return true;
    const value = q[2];
    if (!/[A-Z_-]/.test(value)) return false;
    const before = (scanLine.slice(0, m.index).match(/[\w$]*$/) || [''])[0];
    const norm = (s) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
    return norm(value) === norm(before + q[1]);
  }

  /**
   * True when an identifier-keyed match's value NAMES something — a filename
   * or a credential-word slug — rather than holding a credential. See
   * FILENAME_VALUE_RE / LABEL_VALUE_RE for the measured shapes and the
   * entropy guard that bounds them.
   *
   * @param {string} match - the full regex match, identifier through value
   * @returns {boolean}
   */
  _isLabelValue(match) {
    const q = match.match(/['"]([^'"]*)$/);
    if (!q) return false;
    const value = q[1];
    if (isCredentialShaped(value)) return false;
    if (FILENAME_VALUE_RE.test(value)) return true;
    return LABEL_VALUE_RE.test(value) && LABEL_CREDENTIAL_WORD_RE.test(value);
  }

  /**
   * True when an identifier-keyed match's value is a well-known OAuth
   * grant-type / token-type / response-type enum constant on a line that
   * names one of those fields. See OAUTH_ENUM_VALUES for the defect (#682).
   *
   * Checked against the LINE, not just the match, because the base regex
   * keys off whichever property on the object literal happens to end in
   * `token`/`bearer`/`secret`/`password` (`refresh_token: "…"` — the base
   * regex cannot see that `grant_type` sits earlier in the same statement),
   * so the OAuth-field test has to look at the statement, not the match.
   *
   * @param {string} scanLine - the neutralised line the pattern ran on
   * @param {RegExpExecArray} m - the identifier-keyed match
   * @returns {boolean}
   */
  _isOAuthEnumValue(scanLine, m) {
    const q = m[0].match(/['"]([^'"]*)$/);
    if (!q) return false;
    if (!OAUTH_ENUM_VALUES.has(q[1].toLowerCase())) return false;
    return OAUTH_FIELD_RE.test(scanLine);
  }

  /**
   * Is line `i` documentation — inside a block comment, or (Python) inside a
   * multi-line string, which is a docstring in every case that matters?
   *
   *   sindresorhus/got  source/core/options.ts:260
   *       secret: 'passphrase'
   *
   * sits in a fenced example inside a `/** … *\/` TSDoc block whose inner
   * lines carry no `*` prefix, so the line-start comment test above could
   * not see it: blocked at confidence 1.0. The mask (src/core/source-strip.js,
   * one definition of where a comment begins and ends) can.
   *
   * Judged at the line's FIRST non-space character, the way the confidence
   * layer judges a comment (confidence.js isInsideBlockComment): a trailing
   * comment after real code leaves that code real. In JS a multi-line
   * TEMPLATE literal is not skipped — an `.env` body inlined in a backtick
   * string is a committed credential — only Python's triple-quoted strings
   * are, because the docstring is where django keeps its doctests.
   *
   * @param {string[]} lines - raw lines
   * @param {string[]} masked - the same lines masked by _maskedLines
   * @param {number} i
   * @param {boolean} python
   * @returns {boolean}
   */
  _inDocContext(lines, masked, i, python) {
    const raw = lines[i] || '';
    const first = raw.search(/\S/);
    if (first === -1) return false;
    const kind = literalKindAt(lines, masked, i, first);
    return kind === 'comment' || (python && kind === 'string');
  }

  /**
   * Is the match at raw column `col` the SOURCE of a regex literal?
   * `/AKIA[0-9A-Z]{16}/` in a pattern table is a description of a key, not
   * a key; the same text in quotes is a value and stays reported.
   *
   * @param {string[]} lines
   * @param {string[]} masked
   * @param {number} i
   * @param {number} col - column on the raw line; -1 when unknown
   * @returns {boolean}
   */
  _inRegexLiteral(lines, masked, i, col) {
    if (col < 0) return false;
    return literalKindAt(lines, masked, i, col) === 'regex';
  }

  /**
   * Could this vendor-shaped match be a LIVE credential? See the
   * PUBLISHED_EXAMPLE_CREDENTIALS comment for the three things it cannot be.
   * Only consulted where the value sits in an illustration context (a test
   * tree, prose); identifier-keyed types never reach it.
   *
   * @param {{type: string}} pattern
   * @param {string} value - the full regex match
   * @param {string[]} lines - the raw file
   * @param {number} i - index of the current line
   * @returns {boolean}
   */
  _couldBeLive(pattern, value, lines, i) {
    if (!VENDOR_SHAPED_TYPES.has(pattern.type)) return false;
    if (pattern.type === 'Private Key') {
      // Key material on the header's own line (after the header) or the
      // next line, whose tail is not a typed run.
      const after = lines[i].slice(lines[i].indexOf(value) + value.length);
      const window = `${after}\n${lines[i + 1] || ''}`;
      return (window.match(KEY_MATERIAL_RE) || []).some((run) => !SYNTHETIC_RUN_RE.test(run.slice(-32)));
    }
    if (PUBLISHED_EXAMPLE_CREDENTIALS.has(value)) return false;
    return !SYNTHETIC_RUN_RE.test(value) && !hasSequentialRun(value);
  }

  /**
   * True when the matched value is a key its vendor designed to be public.
   * See PUBLISHABLE_KEY_RE / ALGOLIA_KEY_RE for the contract.
   *
   * @param {string[]} lines - the whole file, for the lookback window
   * @param {number} i - index of the current line
   * @param {string} match - the full regex match
   * @returns {boolean}
   */
  _isPublicByDesign(lines, i, match) {
    const q = match.match(/['"]([^'"]*)$/);
    if (!q) return false;
    const value = q[1];
    if (PUBLISHABLE_KEY_RE.test(value)) return true;
    if (!ALGOLIA_KEY_RE.test(value) || !/^api[_-]?key\s*[:=]/i.test(match)) return false;
    const window = lines.slice(Math.max(0, i - SEARCH_CONFIG_WINDOW), i + 1).join('\n');
    return /\b(?:algolia|docsearch)\b/i.test(window) && !/\b(?:admin|write|secret)\b/i.test(window);
  }

  /**
   * Classify a `.pem` / `.key` style file by its header.
   *
   * @param {string} file - absolute path
   * @returns {'private'|'public'|'unknown'}
   */
  _classifyKeyFile(file) {
    let head = '';
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(KEY_FILE_HEAD_BYTES);
        const n = fs.readSync(fd, buf, 0, KEY_FILE_HEAD_BYTES, 0);
        head = buf.toString('utf-8', 0, n);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return 'unknown';
    }
    if (PRIVATE_KEY_HEADER_RE.test(head)) return 'private';
    if (PUBLIC_PEM_HEADER_RE.test(head)) return 'public';
    return 'unknown';
  }

  /**
   * A key file the working tree ignores is a developer's local material, not
   * a committed one. Outside a git checkout nothing is ignored — the module
   * fails toward detection.
   *
   * @param {string} projectRoot
   * @param {string} relUnix
   * @returns {boolean}
   */
  _isGitIgnored(projectRoot, relUnix) {
    const { exitCode } = this._exec(`git check-ignore -q -- "${relUnix.replace(/"/g, '\\"')}"`, {
      cwd: projectRoot,
      timeout: 5000,
    });
    return exitCode === 0;
  }

  /**
   * Blank out string literals that are OPERANDS of a comparison, leaving the
   * rest of the line intact.
   *
   * `if (password === 'REJECTED_VALUE')` compares against a sentinel and is
   * not a secret. The module used to express that by skipping any line
   * containing `===`, which also silenced every real credential sharing a
   * line with a comparison — a hardcoded `sk_live_` key in a ternary was
   * invisible despite the module having an explicit pattern for it.
   *
   * Removing just the operand keeps the sentinel quiet AND keeps the
   * assignment's own literal visible, so one rule no longer trades away the
   * other. Handles both operand orders and loose (`==`) comparisons.
   *
   * @param {string} line
   * @returns {string} the line with comparison operands neutralised
   */
  _stripComparisonLiterals(line) {
    return line
      .replace(/(?:[!=]==?)\s*(['"])(?:(?!\1).)*\1/g, '== 0')
      .replace(/(['"])(?:(?!\1).)*\1\s*(?:[!=]==?)/g, '0 ==');
  }

  /**
   * Detect a hardcoded credential used as the FALLBACK on an env-var read:
   *
   *     const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'layova-admin';
   *     SECRET = os.environ.get('AUTH_SECRET', 'dev-secret-change-me')
   *
   * This is not a hypothetical. It is the credential that authenticates
   * every request in any environment where the var is unset, it is committed
   * in plain text, and it survives to production far more often than a
   * directly-assigned secret because the code "looks like" it uses env vars.
   *
   * Narrow on purpose, so the blanket-skip this replaces keeps protecting
   * against its original false positive:
   *   - the NAME must read as a credential (a `process.env.PORT ?? '3000'`
   *     fallback is configuration, not a secret);
   *   - a bare read with no literal fallback returns null;
   *   - the literal runs through the same placeholder / prose / reference
   *     suppressions as every other value, so `?? 'changeme'` stays quiet.
   *
   * @param {string} line - the source line, known to contain `process.env`
   * @returns {string|null} the offending literal, or null
   */
  _envFallbackSecret(line) {
    // The name may sit on either side: the assigned identifier, or the env
    // key itself. Either reading as credential-shaped is enough.
    const NAME = /(?:secret|password|passwd|pwd|token|api[_-]?key|apikey|credential|passphrase|private[_-]?key|auth)/i;
    const assigned = line.match(/(?:const|let|var|final|static)?\s*([A-Za-z_$][\w$]*)\s*[:=]\s*(?![=])/);
    const envKey = line.match(/process\.env(?:\.([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])/);
    const names = [assigned && assigned[1], envKey && (envKey[1] || envKey[2])].filter(Boolean);
    if (!names.some((n) => NAME.test(n))) return null;

    // `||` / `??` fallback, or a template-literal default. Require 6+ chars:
    // shorter values are flags and sentinels, not credentials.
    const fb = line.match(/(?:\|\||\?\?)\s*(['"])([^'"]{6,})\1/);
    if (!fb) return null;
    const value = fb[2];

    // Reuse the module's own suppressions. They take the full regex-match
    // shape (identifier through value), so hand them a synthetic one rather
    // than duplicating the placeholder list — one definition, one behaviour.
    const synthetic = `${names[0]}="${value}`;
    if (PLACEHOLDER_VALUE_RE.test(value)) return null;
    if (this._looksLikeProse(synthetic)) return null;
    if (this._looksLikeReference(synthetic)) return null;

    return value;
  }

  _looksLikeProse(match) {
    const q = match.match(/['"]([^'"]*)$/);
    if (!q) return false;
    const value = q[1];
    const words = value.trim().split(/\s+/).filter(Boolean);
    if (words.length < 4) return false;
    // Any contiguous 12+ char run that mixes letters with digits or base64
    // padding is key-shaped — never treat that as prose. Checked per-run so
    // a sentence that merely happens to contain a digit elsewhere is safe.
    const runs = value.match(/[A-Za-z0-9+/=_-]{12,}/g) || [];
    if (runs.some((r) => /[A-Za-z]/.test(r) && /[0-9+/=]/.test(r))) return false;
    // Every word must be plain language: letters, digits, and ordinary
    // sentence punctuation. Underscores, braces, brackets and backslashes
    // signal code, so a value containing them is not treated as prose.
    return words.every((w) => /^[A-Za-z0-9''""«»,.;:!?()\-—–/&%]+$/.test(w));
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const sourceExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs',
      '.java', '.env', '.yml', '.yaml', '.json', '.toml', '.cfg', '.ini', '.conf',
      '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
      // Documentation. A live key pasted into a README or a SETUP guide is one
      // of the most common ways credentials actually get committed, and until
      // 2026-09-01 this module could not see any of them: a real
      // `sk_live_…` planted in README.md produced ZERO findings.
      //
      // Found while cross-checking against another engine. It had reported a
      // docs guide as a hardcoded-credential CRITICAL, and I set out to show
      // ours stayed quiet on the same file. It did — because it never opened
      // it. Silence from not looking is not precision, and the two are
      // indistinguishable from the outside unless you plant a positive
      // control, which is what turned a favourable comparison into a defect.
      //
      // The false positives docs invite (`your-api-key-here`, `sk_live_xxxx`,
      // `<paste-key>`) are already handled by the placeholder allow-list this
      // module shares between both of its scan paths.
      '.md', '.mdx', '.txt', '.rst', '.adoc',
      ...KEY_FILE_EXTENSIONS];

    const files = this._collectFiles(projectRoot, sourceExtensions);
    let totalSecrets = 0;
    // Key files this scan has already judged — reported as private key
    // material, or recognised as public. The .gitignore hygiene check below
    // must not escalate to a second blocking finding for the same file.
    const vouched = new Set();

    for (const file of files) {
      const relPath = repoRelative(projectRoot, file);

      // Skip test fixtures, example and mock files — by SEGMENT and by
      // basename token, not substring (doctrine §5): `includes('mock')`
      // also skipped `src/mockingbird.ts`, `includes('example')` skipped
      // `counterexample-search/` (2026-09-05).
      if (FIXTURE_PATH_RE.test(relPath.replace(/\\/g, '/'))) continue;

      // Skip module source files — they contain detection pattern strings
      // that match the very rules they implement (e.g. cookie-security.js
      // has "changeme" as a weak-secret pattern, not an actual secret).
      const relUnix = relPath.replace(/\\/g, '/');
      if (/(?:^|\/)src[\\/]modules[\\/]/.test(relUnix)) continue;

      if (KEY_FILE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
        const kind = this._classifyKeyFile(file);
        if (kind === 'public') { vouched.add(relUnix); continue; }
        if (kind !== 'private') continue;
        if (this._isGitIgnored(projectRoot, relUnix)) continue;
        vouched.add(relUnix);
        totalSecrets += 1;
        result.addCheck(`secrets:${relPath}`, false, {
          severity: this._isTestPath(relUnix) ? 'warning' : 'error',
          file: relPath,
          message: 'Private key material is committed in this file',
          details: [{ type: 'Private Key', line: 1, preview: path.basename(file) }],
          suggestion: 'Remove the key from the repository, rotate it, and add the file pattern to .gitignore',
        });
        continue;
      }

      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split(/\r?\n/);
      const found = [];
      // Block-comment / docstring / regex-literal context, from the shared
      // stripper — only for the languages it parses (DOC_CONTEXT_EXTENSIONS).
      const ext = path.extname(file).toLowerCase();
      const masked = DOC_CONTEXT_EXTENSIONS.has(ext) ? this._maskedLines(content, relUnix) : null;
      const python = ext === '.py';

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // `// secrets-ok` on this line or the previous line suppresses
        const prevLine = i > 0 ? lines[i - 1] : '';
        if (/\bsecrets-ok\b/.test(line) || /\bsecrets-ok\b/.test(prevLine)) continue;

        // Comparison operands are removed, not used to skip the whole line.
        // `if (password === 'REJECTED_VALUE')` really is a sentinel and must
        // stay quiet — but a blanket skip on `===` also hid every credential
        // that merely SHARES a line with a comparison, e.g.
        //   const K = process.env.NODE_ENV === 'production' ? 'sk_live_…' : …
        // which is a live key the module has an explicit pattern for.
        // Strip the operands; whatever literal is left is still a literal.
        let scanLine = this._stripComparisonLiterals(line);

        // Env-var lines are handled on their own terms and never reach the
        // generic patterns below. A bare read (`password = process.env.PW`)
        // holds no secret and must not fire. But a LITERAL FALLBACK
        // (`process.env.ADMIN_PASSWORD ?? 'layova-admin'`) is a real shipped
        // credential: it is what authenticates every request in any
        // environment where the var is unset — which is precisely the
        // environment nobody checked. This branch used to be a blanket
        // `continue`, so that entire class was unreachable by design.
        if (/process\.env\b/.test(line)) {
          const fallback = this._envFallbackSecret(line);
          if (fallback) {
            found.push({
              type: 'Fallback Secret',
              line: i + 1,
              preview: line.substring(0, 80).trim() + (line.length > 80 ? '...' : ''),
            });
          }
          // Neutralise the env READ and carry on into the generic patterns
          // rather than skipping the line. `password = process.env.PW` becomes
          // `password = 0` and correctly matches nothing — but a real
          // credential elsewhere on the line is still seen, e.g.
          //   headers: { authorization: 'sk_live_…', region: process.env.AWS_REGION }
          // (that example deliberately avoids the literal Anthropic auth
          // header — tests/helpers/ai-module-names.js derives "is this an AI
          // module" by grepping module source for it, and a comment carrying
          // it would classify secrets as AI, which would make the
          // deterministic every-push tier SKIP secret detection entirely.)
          // An early `continue` here would have rebuilt the exact blanket skip
          // this commit exists to remove.
          scanLine = scanLine.replace(
            /process\.env(?:\.[A-Za-z_$][\w$]*|\[\s*(['"])[^'"]*\1\s*\])?/g,
            '0',
          );
        }

        // Skip comment lines
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

        for (const pattern of this.patterns) {
          // Reset regex lastIndex for global regexes
          pattern.regex.lastIndex = 0;
          if (pattern.regex.test(scanLine)) {
            // Re-anchor before exec. `test()` above ADVANCED lastIndex on
            // these /g regexes, so the exec used to resume past the match it
            // had just found and return null — which silently disabled every
            // value-based suppression below (placeholders included) for as
            // long as this module has shipped. Reset, exec, reset again.
            pattern.regex.lastIndex = 0;
            // Skip known placeholder / sentinel values that are intentionally visible
            const m = pattern.regex.exec(scanLine);
            pattern.regex.lastIndex = 0;
            if (m) {
              const val = m[0].toLowerCase();
              // `your[_-]?(?:\w+[_-])?` so the extremely common
              // `your_api_key_here` / `your-github-token` shapes are covered,
              // not just the bare `your_key`.
              // `example` is bounded so it only suppresses a standalone
              // placeholder word (`example_secret`, `"example"`). Left
              // unbounded it swallows any high-entropy value that merely
              // contains the substring — including AWS's canonical
              // AKIAIOSFODNN7EXAMPLE — and a secrets module must fail
              // toward detection, never toward silence.
              if (PLACEHOLDER_VALUE_RE.test(val)) continue;
              // A structural header (a PEM marker) matches on its own, so an
              // ellipsis beside it never reaches the value check above. On a
              // line showing a redacted example the header is a description
              // of a format, not a credential.
              if (pattern.illustrationIfElided && /\.{3,}|\u2026/.test(line)) continue;
              // Skip prose values. `CRON_SECRET: 'the scan queue is never
              // drained'` is a docs/description map keyed by env-var NAME —
              // the name matches the rule, the value is an English sentence.
              // Credentials are contiguous high-entropy strings; sentences
              // are not. See _looksLikeProse for the exact test.
              if (this._looksLikeProse(m[0])) continue;
              // Skip values that READ a secret rather than contain one.
              // See _looksLikeReference for the exact test.
              if (this._looksLikeReference(m[0])) continue;
              // A connection string with no credential in it, or a
              // template one. See _databaseUrlIsPlaceholder.
              if (pattern.type === 'Database URL' && this._databaseUrlIsPlaceholder(m[0])) continue;
              // `DYNAMIC_TOKEN = 'DYNAMIC_TOKEN'`, `'jwtSecret' in options`.
              if (this._isSelfReferentialValue(scanLine, m)) continue;
              // Stripe `pk_live_…`, an Algolia DocSearch key in its block.
              if (this._isPublicByDesign(lines, i, m[0])) continue;
              if (IDENTIFIER_KEYED_TYPES.has(pattern.type)) {
                // A name-keyed match is only as good as its value and its
                // context. `token = "make.bat"`, `reset_url_token =
                // "set-password"`, a `>>>` doctest, a `secret: 'passphrase'`
                // inside a TSDoc example — none is a credential. Vendor-shaped
                // matches never reach here: an AKIA key in a comment is still
                // a key.
                if (this._isLabelValue(m[0])) continue;
                if (this._isOAuthEnumValue(scanLine, m)) continue;
                if (DOCTEST_LINE_RE.test(line)) continue;
                if (masked && this._inDocContext(lines, masked, i, python)) continue;
              } else if (masked) {
                // `/AKIA[0-9A-Z]{16}/` — the source of a regex literal is a
                // description of a key's shape, not a key. `scanLine` may
                // have been rewritten (comparison operands, env reads), so
                // the column is re-found on the raw line; unknown → not a
                // regex, reported (fail toward detection).
                if (this._inRegexLiteral(lines, masked, i, line.indexOf(m[0]))) continue;
              }
            }
            found.push({
              type: pattern.type,
              line: i + 1,
              preview: line.substring(0, 80).trim() + (line.length > 80 ? '...' : ''),
              // Decides the tier in a test tree or prose; irrelevant in src/.
              live: this._couldBeLive(pattern, m ? m[0] : '', lines, i),
            });
          }
        }
      }

      if (found.length > 0) {
        totalSecrets += found.length;
        // One definition of "test path" for the whole engine (base-module
        // TEST_PATH_RE). The private copy this replaced did not know
        // `js_tests/` or `runtime-tests/`, so django's QUnit fixtures blocked.
        const isTest = this._isTestPath(relUnix);

        // PROSE vs CONFIG vs CODE.
        //
        // Documentation is read for credentials (a key pasted into a README is
        // leaked), but documentation is also the one place a generic
        // `password: "myPassword"` is expected rather than alarming. Measured
        // on axios @81df7a5: nine findings across its HTTP Basic auth docs in
        // four languages, all of them the library explaining itself.
        //
        // So in prose, only a VENDOR-SHAPED credential is confident enough to
        // block. Those are unmistakable by their value alone — nobody writes
        // `AKIA…` or a PEM header to illustrate a concept. Generic
        // identifier-keyed patterns keep default scoring, which applies the
        // doc-file discount and leaves them visible but non-blocking.
        //
        // Config formats are deliberately NOT prose. A credential in a
        // `.yaml`, `.toml`, `.ini` or `.env` is real, and that boundary is
        // the one someone will be tempted to move later.
        const isProse = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i.test(relUnix);
        // A vendor-shaped value that is not a published example, not visibly
        // synthetic, and (for a PEM) has key material behind it — see
        // PUBLISHED_EXAMPLE_CREDENTIALS. Everything else in a test tree or
        // in prose is an illustration: reported at info so it stays on the
        // record without becoming a Code Scanning alert on every pull
        // request (the SARIF reporter drops info; 53 test files and two docs
        // were alerts on 2026-09-13). The tiers, in order:
        //   src/                       error   (nothing here applies)
        //   test tree, could be live   warning ("a test file does not make an AWS key fake")
        //   test tree, fixture         info
        //   prose, could be live       error at confidence 1 (lifted out of the doc discount)
        //   prose, illustration        info
        const live = found.some((f) => f.live);
        const details = found.map(({ live: _live, ...f }) => f);
        let severity = 'error';
        let message = `${found.length} potential secret(s) found`;
        let suggestion = 'Move secrets to environment variables and add file to .gitignore';
        if (isTest && !live) {
          severity = 'info';
          message = `${found.length} credential-shaped fixture(s) in a test file — on record, not a leak`;
          suggestion = 'Nothing to change unless one of these is a real credential — then it does not belong in a test either: read it from an env var.';
        } else if (isTest) {
          severity = 'warning';
        } else if (isProse && !live) {
          severity = 'info';
          message = `${found.length} credential-shaped example(s) in documentation — on record, not a leak`;
          suggestion = 'Nothing to change unless one of these is a real credential — then rotate it and replace it with a placeholder such as `<your-api-key>`.';
        }

        result.addCheck(`secrets:${relPath}`, false, {
          severity,
          file: relPath,
          message,
          details,
          // An explicit confidence wins over the signal-based score, so this
          // lifts a vendor-shaped credential back out of the doc discount.
          ...(isProse && live ? { confidence: 1 } : {}),
          suggestion,
        });
      }
    }

    // Check for .env files committed to git
    this._checkEnvFiles(projectRoot, result);

    // Check .gitignore for secret file patterns
    this._checkGitignore(projectRoot, result, vouched);

    if (totalSecrets === 0) {
      result.addCheck('secrets-scan', true, { message: `Scanned ${files.length} files, no secrets found` });
    }
  }

  _checkEnvFiles(projectRoot, result) {
    const dangerousFiles = ['.env', '.env.local', '.env.production', 'credentials.json',
      'service-account.json', 'key.pem', 'id_rsa', '.npmrc'];

    // `.npmrc` is the one file on this list that is routinely and correctly
    // committed: it carries registry config, and `ignore-scripts=true` in a
    // tracked .npmrc is a supply-chain BEST practice. expressjs/express,
    // fastify, got and zod all ship one and all four were reported at
    // CRITICAL for it. Only an .npmrc carrying an actual credential is a
    // finding — which is what security.js:_checkNpmrc already tests for.
    // The same principle now covers every file on the list: the filename is
    // a prior, the content is the evidence — see _trackedFileVerdict.
    for (const filename of dangerousFiles) {
      const filePath = path.join(projectRoot, filename);
      if (fs.existsSync(filePath)) {
        const verdict = this._trackedFileVerdict(filename, filePath);
        if (!verdict) continue;
        // Is it tracked by git? Three answers, not two:
        //   exit 0            → tracked: report the verdict.
        //   exit 1, git ran   → git answered "not tracked": nothing to report.
        //   anything else     → git could NOT answer (timed out under load,
        //                       not a checkout: exit 128, binary missing:
        //                       spawnError) — fail toward detection and say
        //                       why. Found 2026-09-13: under a loaded test run
        //                       the 5 s probe timed out and a tracked .npmrc
        //                       holding an _authToken was reported as clean.
        // No `2>/dev/null`: _exec already pipes stderr, and under cmd.exe the
        // redirect names a real file (`C:\dev\null` on any box with a C:\dev
        // folder) that concurrent probes then fight over — "being used by
        // another process", exit 1, read as "not tracked" (2026-09-14: the
        // .env / .npmrc controls flaked exactly this way under the full suite).
        const probe = this._exec(`git ls-files --error-unmatch "${filename}"`, {
          cwd: projectRoot,
          timeout: 5000,
        });
        const answeredNotTracked = probe.exitCode === 1 && !probe.timedOut && !probe.spawnError;
        if (answeredNotTracked) continue;
        const unconfirmed = probe.exitCode !== 0;
        const why = probe.timedOut ? 'git timed out' : probe.spawnError ? `git could not run (${probe.spawnError})` : `git exit ${probe.exitCode}`;
        result.addCheck(`secrets:tracked-${filename}`, false, {
          file: filename,
          severity: verdict.severity,
          message: unconfirmed
            ? `${verdict.message} — git could not confirm whether it is tracked (${why}); reported so a committed credential cannot hide behind a git failure`
            : verdict.message,
          suggestion: `Add "${filename}" to .gitignore and remove from git tracking`,
        });
      }
    }
  }

  /**
   * What a TRACKED sensitive-looking file actually holds decides its severity
   * (ported from #418, 2026-09-02):
   *
   *   - key material (`key.pem`, `id_rsa`)                 -> error, always
   *   - `.npmrc` with `_authToken` / `_auth` / `_password`  -> error
   *   - `.npmrc` with only config keys                      -> null (no finding)
   *   - `.env*` with a real-looking value                   -> error
   *   - `.env*` with only blanks / placeholders / refs      -> warning (hygiene)
   *   - `credentials.json` etc. with a credential key       -> error, else warning
   *
   * @returns {{severity: string, message: string}|null}
   */
  _trackedFileVerdict(filename, filePath) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      return { severity: 'warning', message: `${filename} is tracked by git but could not be read (${err.message}) — verify it holds no credential` };
    }
    const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith(';'));
    const tracked = `${filename} is tracked by git`;

    if (/^(?:key\.pem|id_rsa)$/.test(filename)) {
      return { severity: 'error', message: `${tracked} — private key material must never be committed` };
    }
    if (filename === '.npmrc') {
      if (lines.some((l) => /(?:_authToken|_auth|_password|:username|:email)\s*=/i.test(l))) {
        return { severity: 'error', message: `${tracked} and carries a registry credential` };
      }
      return null; // config-only .npmrc is the recommended way to pin npm behaviour
    }
    if (filename.startsWith('.env')) {
      const live = lines.some((l) => {
        const m = l.match(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/);
        if (!m) return false;
        const v = m[1].replace(/^['"]|['"]$/g, '').trim();
        if (v.length < 8) return false;
        if (/^\$\{?[A-Za-z_]/.test(v)) return false;           // ${VAR} / $VAR reference
        return !PLACEHOLDER_VALUE_RE.test(v);
      });
      return live
        ? { severity: 'error', message: `${tracked} and holds at least one real-looking value` }
        : { severity: 'warning', message: `${tracked} — it holds only blanks or placeholders today; a real value will be committed the first time someone fills it in` };
    }
    if (/"(?:private_key|client_secret|secret|token|password|api_key)"\s*:\s*"[^"]{8,}"/i.test(content)) {
      return { severity: 'error', message: `${tracked} and contains a credential-shaped value` };
    }
    return { severity: 'warning', message: `${tracked} — this filename usually holds credentials; verify it is meant to be public` };
  }

  /**
   * Does a file the given .gitignore pattern would have covered actually
   * exist in the tree? Decides whether a missing pattern is a live exposure
   * (error) or a hygiene advisory (warning).
   *
   * Deliberately narrow: handles the three patterns this module requires
   * (`.env`, `*.pem`, `*.key`) rather than implementing gitignore globbing.
   * `.env` matches `.env` and any `.env.*`, mirroring how the pattern behaves
   * in practice. Bounded walk — skips vendor/build dirs and stops at depth 6
   * so a huge monorepo cannot make the secrets module the slow one.
   *
   * A file the content scan has already VOUCHED for does not count: a
   * private key it reported is already blocking under its own path (nest's
   * `integration/microservices/src/tcp-tls/privkey.pem`), and a certificate
   * bundle it recognised as public is not an exposure at all (apollo-server's
   * root `.cacert.pem`). Either way the missing pattern is hygiene. An opaque
   * `.pem` the scan could not classify still escalates — the module fails
   * toward detection.
   *
   * @param {string} projectRoot
   * @param {string} pattern - one of `.env`, `*.pem`, `*.key`
   * @param {Set<string>} [vouched] - forward-slash relative paths already judged
   * @returns {boolean}
   */
  _matchingFileExists(projectRoot, pattern, vouched = new Set()) {
    // Test fixtures / examples / testdata are COMMITTED ON PURPOSE (flask's
    // tests/test_apps/.env, gin's testdata/certificate/*.pem) — their
    // presence is not evidence that a real secret is about to leak, so they
    // do not make the missing-pattern advisory a blocking error.
    const SKIP = new Set([...WALK_EXCLUDES,
      'test', 'tests', '__tests__', 'spec', 'specs', 'fixtures', 'fixture', 'testdata', 'test_apps', 'examples', 'example', 'docs', 'benchmarks', 'known-bad', 'reliability-corpus']);
    const matches = (name) => (
      pattern === '.env'
        ? (name === '.env' || name.startsWith('.env.'))
        : name.endsWith(pattern.slice(1))
    );

    const walk = (dir, depth) => {
      if (depth > 6) return false;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return false; // unreadable dir is not evidence of a secret
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIP.has(entry.name)) continue;
          if (walk(path.join(dir, entry.name), depth + 1)) return true;
        } else if (matches(entry.name) && !/\.(example|sample|template|dist)$/.test(entry.name)) {
          const rel = repoRelative(projectRoot, path.join(dir, entry.name));
          if (vouched.has(rel)) continue;
          return true;
        }
      }
      return false;
    };

    return walk(projectRoot, 0);
  }

  _checkGitignore(projectRoot, result, vouched = new Set()) {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      result.addCheck('secrets:gitignore-exists', false, {
        // Warning, not error: missing setup files are hygiene advisories.
        // Actually-committed secrets still block (the scanner checks the
        // real file contents); a brand-new repo's first scan shouldn't be
        // BLOCKED over a file it hasn't created yet (first-run audit
        // 2026-07-23 — same rationale as lint:eslint-config and
        // security:gitignore-missing).
        severity: 'warning',
        message: 'No .gitignore file found',
        suggestion: 'Create a .gitignore that excludes .env, credentials, and key files',
        autoFix: () => {
          try {
            const template = 'node_modules/\n.env\n.env.*\n*.pem\n*.key\ncredentials.json\n.DS_Store\n';
            fs.writeFileSync(gitignorePath, template, 'utf-8');
            return { fixed: true, description: 'Created .gitignore with standard secret exclusions', filesChanged: ['.gitignore'] };
          } catch { return { fixed: false }; }
        },
      });
      return;
    }

    const content = fs.readFileSync(gitignorePath, 'utf-8');
    const requiredPatterns = ['.env', '*.pem', '*.key'];

    for (const pat of requiredPatterns) {
      if (!content.includes(pat)) {
        const gitignore = gitignorePath;
        const patToAdd = pat;
        // Only an ERROR when the risk is live — i.e. a file this pattern
        // would have covered actually exists in the tree. Otherwise it is a
        // hygiene advisory about a file the repo does not have.
        //
        // Why (neutral-repo audit 2026-08-12): scanning expressjs/express —
        // which contains no .env, .pem or .key file anywhere — produced three
        // of these at full confidence and they were 3 of the 5 findings that
        // BLOCKED the gate. Every blocking line on a healthy repo was noise,
        // which is precisely how a gate teaches its customer to bypass it.
        //
        // Same rationale as the missing-.gitignore branch above, which was
        // already downgraded on 2026-07-23: it is incoherent for "no
        // .gitignore at all" to warn while "an existing .gitignore missing
        // one line" blocks.
        const atRisk = this._matchingFileExists(projectRoot, pat, vouched);
        result.addCheck(`secrets:gitignore-${pat}`, false, {
          severity: atRisk ? 'error' : 'warning',
          message: atRisk
            ? `.gitignore missing pattern: ${pat} — and a matching file exists in the tree`
            : `.gitignore missing pattern: ${pat}`,
          suggestion: `Add "${pat}" to .gitignore`,
          autoFix: () => {
            try {
              fs.appendFileSync(gitignore, `\n${patToAdd}\n`);
              return { fixed: true, description: `Added "${patToAdd}" to .gitignore`, filesChanged: ['.gitignore'] };
            } catch { return { fixed: false }; }
          },
        });
      }
    }
  }
}

module.exports = SecretsModule;
// The one list of credentials a vendor PUBLISHED as the example to write in
// docs. security.js's own AWS rule needs the same answer: this module's
// pattern table carries `AKIAIOSFODNN7EXAMPLE` on purpose, and security.js
// reported it as "Potential AWS Access Key" in src/modules/secrets.js:166,
// which blocked the full suite on this repository (2026-09-14).
module.exports.PUBLISHED_EXAMPLE_CREDENTIALS = PUBLISHED_EXAMPLE_CREDENTIALS;
