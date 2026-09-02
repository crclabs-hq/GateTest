/**
 * Secrets Module - Scans for hardcoded secrets, API keys, tokens, and passwords.
 * Zero tolerance for secrets in source code or git history.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');

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
const PLACEHOLDER_VALUE_RE = /(?:changeme|placeholder|your[_-]?(?:\w+[_-])?(?:secret|key|password|token)|replace[_-]?me|(?<![a-z0-9])example(?![a-z0-9])|default[_-]?(?:secret|key|password|token)|xxx+|insert[_-]?here|todo|<[a-z0-9_. -]{2,30}>)/i;

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

class SecretsModule extends BaseModule {
  constructor() {
    super('secrets', 'Secret & Credential Detection');
    this.patterns = [
      { regex: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{8,}/gi, type: 'API Key' },
      { regex: /(?:secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}/gi, type: 'Password/Secret' },
      { regex: /(?:token|bearer)\s*[:=]\s*['"][^'"]{8,}/gi, type: 'Token' },
      { regex: /(?:aws|amazon).{0,20}(?:key|secret|token).{0,20}['"][A-Za-z0-9/+=]{20,}/gi, type: 'AWS Credential' },
      { regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g, type: 'Private Key' },
      { regex: /ghp_[A-Za-z0-9_]{36,}/g, type: 'GitHub PAT' },
      { regex: /gho_[A-Za-z0-9_]{36,}/g, type: 'GitHub OAuth Token' },
      { regex: /github_pat_[A-Za-z0-9_]{22,}/g, type: 'GitHub Fine-Grained Token' },
      { regex: /sk-[A-Za-z0-9]{32,}/g, type: 'OpenAI/Stripe Key' },
      { regex: /sk_live_[A-Za-z0-9]{24,}/g, type: 'Stripe Live Key' },
      { regex: /xox[bprs]-[A-Za-z0-9-]{10,}/g, type: 'Slack Token' },
      { regex: /(?:mongodb|postgres|mysql|redis):\/\/[^'"\s]{10,}/gi, type: 'Database URL' },
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
  /**
   * Does a `-----BEGIN … PRIVATE KEY-----` header have key material behind
   * it? A real PEM body is base64 in 64-column lines; a doc that shows the
   * FORMAT writes `-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END` and
   * stops. Found by the self-scan on docs/ops/GO_LIVE_RUNBOOK.md, which
   * blocked the gate at confidence 1.0 on exactly that placeholder — the
   * header regex is vendor-shaped (never a false positive on its own), so
   * the body is the only thing left to check.
   *
   * Looks at the remainder of the header's own line (single-line env-style
   * keys with literal `\n`) and the next three lines. Fail-closed: any run of
   * 40+ base64 characters counts, so a truncated-but-real key still fires.
   *
   * @param {string[]} lines
   * @param {number} i - index of the header line
   * @param {number} afterIdx - offset in that line just past the header
   * @returns {boolean}
   */
  _pemHasBody(lines, i, afterIdx) {
    const BODY_RUN = /[A-Za-z0-9+/=]{40,}/;
    if (BODY_RUN.test(lines[i].slice(afterIdx))) return true;
    for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
      if (BODY_RUN.test(lines[j])) return true;
    }
    return false;
  }

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
      '.md', '.mdx', '.txt', '.rst', '.adoc'];

    const files = this._collectFiles(projectRoot, sourceExtensions);
    let totalSecrets = 0;

    for (const file of files) {
      const relPath = path.relative(projectRoot, file);

      // Skip test fixtures and example files
      if (relPath.includes('fixture') || relPath.includes('example') || relPath.includes('mock')) {
        continue;
      }

      // Skip module source files — they contain detection pattern strings
      // that match the very rules they implement (e.g. cookie-security.js
      // has "changeme" as a weak-secret pattern, not an actual secret).
      const relUnix = relPath.replace(/\\/g, '/');
      if (/(?:^|\/)src[\\/]modules[\\/]/.test(relUnix)) continue;

      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split(/\r?\n/);
      const found = [];

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
              // Skip prose values. `CRON_SECRET: 'the scan queue is never
              // drained'` is a docs/description map keyed by env-var NAME —
              // the name matches the rule, the value is an English sentence.
              // Credentials are contiguous high-entropy strings; sentences
              // are not. See _looksLikeProse for the exact test.
              if (this._looksLikeProse(m[0])) continue;
              // Skip values that READ a secret rather than contain one.
              // See _looksLikeReference for the exact test.
              if (this._looksLikeReference(m[0])) continue;
              // A PEM header with no key material after it is documentation
              // of the format, not a key. See _pemHasBody.
              if (pattern.type === 'Private Key' && !this._pemHasBody(lines, i, m.index + m[0].length)) continue;
            }
            found.push({
              type: pattern.type,
              line: i + 1,
              preview: line.substring(0, 80).trim() + (line.length > 80 ? '...' : ''),
            });
          }
        }
      }

      if (found.length > 0) {
        totalSecrets += found.length;
        const isTest = /(?:^|\/)(?:tests?|__tests__|spec|fixtures?|e2e)[\\/]|\.(?:test|spec)\.[a-z]+$/i.test(relUnix);

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
        const vendorShaped = found.some((f) => VENDOR_SHAPED_TYPES.has(f.type));

        result.addCheck(`secrets:${relPath}`, false, {
          severity: isTest ? 'warning' : 'error',
          file: relPath,
          message: `${found.length} potential secret(s) found`,
          details: found,
          // An explicit confidence wins over the signal-based score, so this
          // lifts a vendor-shaped credential back out of the doc discount.
          ...(isProse && vendorShaped ? { confidence: 1 } : {}),
          suggestion: 'Move secrets to environment variables and add file to .gitignore',
        });
      }
    }

    // Check for .env files committed to git
    this._checkEnvFiles(projectRoot, result);

    // Check .gitignore for secret file patterns
    this._checkGitignore(projectRoot, result);

    if (totalSecrets === 0) {
      result.addCheck('secrets-scan', true, { message: `Scanned ${files.length} files, no secrets found` });
    }
  }

  _checkEnvFiles(projectRoot, result) {
    const dangerousFiles = ['.env', '.env.local', '.env.production', 'credentials.json',
      'service-account.json', 'key.pem', 'id_rsa', '.npmrc'];

    for (const filename of dangerousFiles) {
      const filePath = path.join(projectRoot, filename);
      if (fs.existsSync(filePath)) {
        // Check if it's tracked by git
        const { exitCode } = this._exec(`git ls-files --error-unmatch "${filename}" 2>/dev/null`, {
          cwd: projectRoot,
        });
        if (exitCode === 0) {
          const verdict = this._trackedFileVerdict(filename, filePath);
          if (!verdict) continue;
          result.addCheck(`secrets:tracked-${filename}`, false, {
            file: filename,
            severity: verdict.severity,
            message: verdict.message,
            suggestion: `Add "${filename}" to .gitignore and remove from git tracking`,
          });
        }
      }
    }
  }

  /**
   * What a TRACKED sensitive-looking file actually holds decides its severity.
   *
   * expressjs/express commits a `.npmrc` containing exactly four lines:
   * `package-lock=false`, `min-release-age=7`, `ignore-scripts=true`,
   * `allow-git=none`. That is supply-chain hygiene, and the 2026-09-02 corpus
   * gate found us BLOCKING express for it with "this file likely contains
   * secrets" at confidence 1.0. The filename is a prior, not evidence; the
   * content is the evidence.
   *
   *   - key material (`key.pem`, `id_rsa`)            -> error, always
   *   - `.npmrc` with `_authToken` / `_auth` / `_password` -> error
   *   - `.npmrc` with only config keys                 -> null (no finding)
   *   - `.env*` with a real-looking value              -> error
   *   - `.env*` with only blanks / placeholders / refs -> warning (hygiene)
   *   - `credentials.json` etc. with a credential key  -> error, else warning
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
   * @param {string} projectRoot
   * @param {string} pattern - one of `.env`, `*.pem`, `*.key`
   * @returns {boolean}
   */
  _matchingFileExists(projectRoot, pattern) {
    // Test fixtures / examples / testdata are COMMITTED ON PURPOSE (flask's
    // tests/test_apps/.env, gin's testdata/certificate/*.pem) — their
    // presence is not evidence that a real secret is about to leak, so they
    // do not make the missing-pattern advisory a blocking error.
    const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor', '.gatetest',
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
          return true;
        }
      }
      return false;
    };

    return walk(projectRoot, 0);
  }

  _checkGitignore(projectRoot, result) {
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
        const atRisk = this._matchingFileExists(projectRoot, pat);
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
