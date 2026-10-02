'use strict';

/**
 * Credential-exposure and disclosure rules — built against Tallrig's bug
 * corpus (docs/cross-test in gluecron.com/ccantynz/tallrig; scored by
 * scripts/cross-test-score.js). Each rule is a defect class Tallrig shipped
 * and fixed (or still has open) that GateTest missed on 2026-10-02:
 *
 *   url-credential-param   a session token read from / written into a URL
 *                          (TALLRIG-2026-003/004/005): URLs land in access
 *                          logs, proxies, Referer headers and browser history
 *   error-detail-leak      an env-var name in a customer-facing message, or a
 *                          config error's text returned in a response
 *                          (TALLRIG-2026-031/032)
 *   weak-kdf               an encryption key made by hashing a secret once
 *                          (TALLRIG-2026-017)
 *
 * Pure: (relPath, lines) → findings. The security module walks the files and
 * reports. Every rule has a control pair in tests/disclosure-rules.test.js —
 * the corpus's own fixed code is the "must stay quiet" half.
 */

const WINDOW = 15;

// Server reads a credential-named query parameter: Hono `c.req.query("token")`,
// WHATWG `searchParams.get("token")`, Express `req.query.token` / `req.query["token"]`.
const SERVER_READ_RE = /(?:\.query\(\s*['"`](?:token|access_token|session|session_token|sessionid|jwt|auth|api_key|apikey)['"`]\s*\)|searchParams\.get\(\s*['"`](?:token|access_token|session|session_token|sessionid|jwt|auth|api_key|apikey)['"`]\s*\)|\breq\.query\.(?:token|access_token|session|session_token|sessionid|jwt|auth|api_key|apikey)\b|\breq\.query\[\s*['"`](?:token|access_token|session|session_token|sessionid|jwt|auth|api_key|apikey)['"`]\s*\])/i;
// What makes the value a SESSION credential rather than a single-purpose
// capability link (invite, unsubscribe, reset): it is handed to the session /
// token verifier.
const SESSION_VALIDATOR_RE = /\b(?:validateSession|verifySession|getSessionUser|sessionFromToken|resolveSession|verifyAccessToken|verifyIdToken|jwt\.verify|authenticateToken)\s*\(/;
// Or its absence is answered 401 with a message about the SESSION — the
// handler is treating it as the login credential.
const SESSION_401_RE = /session[^\n]*\b401\b|\b401\b[^\n]*session/i;
// A read that exists to REFUSE the parameter (the fixed form): compared to
// undefined/null and answered 401/403.
const REJECTION_RE = /(?:!==?|===?)\s*(?:undefined|null)\b/;
const REJECT_STATUS_RE = /\b40[13]\b/;
// Client writes a session token into a URL.
const CLIENT_WRITE_RE = /searchParams\.(?:set|append)\(\s*['"`](?:token|access_token|session|session_token|sessionid|jwt|auth|api_key|apikey)['"`]\s*,\s*([^)]+)\)|[?&](?:token|access_token|session|session_token|sessionid|jwt|auth|api_key|apikey)=\$\{\s*([^}]+)\}/i;
const SESSIONISH_RE = /session|getToken|authToken|accessToken|bearer|jwt/i;

// An env-var-shaped NAME of a credential or endpoint (GITHUB_OAUTH_CLIENT_ID,
// ANTHROPIC_API_KEY). Two segments minimum so "API_KEY" alone (a generic
// label) does not count.
const ENV_NAME_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API_KEY|KEY|TOKEN|SECRET|CLIENT_ID|CLIENT_SECRET|PASSWORD|DSN|DATABASE_URL)\b/;
// Customer-facing fields in a returned object / response body.
const FACING_KEY_RE = /\b(?:note|error|reason|hint|userMessage|publicMessage)\s*:\s*(['"`])/;
const LOG_LINE_RE = /\b(?:console\.\w+|logger\.\w+|log\.\w+|warn|debug)\s*\(/;
const THROW_ENV_RE = /\bthrow\s+new\s+\w*Error\s*\(/;
const ERR_MESSAGE_RE = /\b(?:err|error|e)\.message\b/;
const RESPONSE_SINK_RE = /\.(?:json|send|redirect)\s*\(|\bnew\s+TRPCError\s*\(/;

const CREATE_HASH_RE = /createHash\(\s*['"`](?:sha1|sha-1|sha256|sha-256|sha384|sha512|md5)['"`]\s*\)/i;
const SHARED_SECRET_NAME_RE = /SESSION_SECRET|JWT_SECRET|COOKIE_SECRET|AUTH_SECRET|SIGNING_(?:KEY|SECRET)|sessionSecret|jwtSecret/;
const SECRETISH_RE = /secret|SECRET|passphrase|masterKey|MASTER_KEY|process\.env\./;
const KEY_CONTEXT_RE = /\bfunction\s+\w*[Kk]ey\w*\s*\(|\b\w*[Kk]ey\w*\s*=\s*(?:\(|function|async)|createCipheriv|createDecipheriv/;

// The right-hand side of the last `name = …` in `text`, found without
// building a RegExp from scanned source.
function assignmentOf(name, text) {
  let found = null;
  for (const l of text.split('\n')) {
    const at = l.indexOf(name);
    if (at === -1) continue;
    const before = at === 0 ? '' : l[at - 1];
    if (/[\w$]/.test(before)) continue;
    const rest = l.slice(at + name.length);
    const m = /^\s*=(?!=)\s*([^;]+)/.exec(rest);
    if (m) found = [m[0], m[1]];
  }
  return found;
}

function isComment(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function urlCredentialParam(relPath, lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line)) continue;
    if (SERVER_READ_RE.test(line)) {
      const after = lines.slice(i, i + 4).join('\n');
      if (REJECTION_RE.test(line) && REJECT_STATUS_RE.test(after)) continue;
      const windowText = lines.slice(i, i + WINDOW).join('\n');
      if (!SESSION_VALIDATOR_RE.test(windowText) && !SESSION_401_RE.test(windowText)) continue;
      out.push({
        rule: 'url-credential-param',
        line: i + 1,
        severity: 'error',
        message: `${relPath}:${i + 1} session token accepted from the URL query — it is written to access logs, proxies, Referer headers and browser history`,
        suggestion: 'Refuse ?token= with 401. For EventSource/WebSocket, mint a short-lived, single-use, resource-scoped ticket server-side and pass ?ticket=; non-browser clients send Authorization: Bearer.',
      });
      continue;
    }
    const w = CLIENT_WRITE_RE.exec(line);
    if (w) {
      const value = (w[1] || w[2] || '').trim();
      const before = lines.slice(Math.max(0, i - WINDOW), i + 1).join('\n');
      const varName = (value.match(/^[\w$.]+/) || [''])[0];
      const assigned = varName ? assignmentOf(varName, before) : null;
      if (!SESSIONISH_RE.test(value) && !(assigned && SESSIONISH_RE.test(assigned[1]))) continue;
      out.push({
        rule: 'url-credential-param',
        line: i + 1,
        severity: 'error',
        message: `${relPath}:${i + 1} session token written into a URL — it leaks into server logs, proxies and Referer headers`,
        suggestion: 'Send the session as a header, or exchange it for a short-lived single-use ticket and put only the ticket in the URL.',
      });
    }
  }
  return out;
}

// Where the reader IS the operator — a CLI, a maintenance script, an
// admin-only route — naming the variable to set is the right message.
const OPERATOR_PATH_RE = /(?:^|\/)(?:bin|scripts|cli|tools)\/|\/admin\//;

function errorDetailLeak(relPath, lines) {
  const out = [];
  if (OPERATOR_PATH_RE.test(String(relPath).replace(/\\/g, '/'))) return out;
  const throwsEnvName = lines.some((l) => !isComment(l) && THROW_ENV_RE.test(l) && ENV_NAME_RE.test(l))
    || lines.some((l, i) => !isComment(l) && THROW_ENV_RE.test(l) && ENV_NAME_RE.test(lines.slice(i, i + 3).join(' ')));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line) || LOG_LINE_RE.test(line)) continue;
    const facing = FACING_KEY_RE.exec(line);
    if (facing && ENV_NAME_RE.test(line.slice(facing.index))) {
      const name = line.slice(facing.index).match(ENV_NAME_RE)[0];
      out.push({
        rule: 'error-detail-leak',
        line: i + 1,
        severity: 'warning',
        message: `${relPath}:${i + 1} customer-facing message names the environment variable ${name} — configuration facts belong in the server log`,
        suggestion: 'Return a neutral sentence ("AI suggestions are unavailable right now") and log the variable name, or expose it only to operators.',
      });
      continue;
    }
    if (throwsEnvName && ERR_MESSAGE_RE.test(line)) {
      const windowText = lines.slice(i, i + 4).join('\n');
      if (!RESPONSE_SINK_RE.test(windowText) || LOG_LINE_RE.test(windowText.split('\n').find((l) => RESPONSE_SINK_RE.test(l)) || '')) continue;
      out.push({
        rule: 'error-detail-leak',
        line: i + 1,
        severity: 'warning',
        message: `${relPath}:${i + 1} an error's message is returned to the client, and this file throws errors that name environment variables`,
        suggestion: 'Log err.message server-side and answer with a neutral message (or a redirect with an error slug); never put configuration text in a response.',
      });
    }
  }
  return out;
}

function weakKdf(relPath, lines) {
  const out = [];
  const fileUsesCipher = lines.some((l) => /createCipheriv|createDecipheriv/.test(l));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line) || !CREATE_HASH_RE.test(line)) continue;
    const chain = lines.slice(i, i + 4).join(' ');
    const upd = /\.update\(\s*([^)]+)\)/.exec(chain);
    if (!upd || !/\.digest\(\s*\)/.test(chain)) continue; // a Buffer digest is a key; a hex/base64 digest is an id
    const context = lines.slice(Math.max(0, i - 10), i + 1).join('\n');
    const keyish = fileUsesCipher || KEY_CONTEXT_RE.test(context);
    if (!keyish || !(SECRETISH_RE.test(upd[1]) || SECRETISH_RE.test(context))) continue;
    // ERROR when the secret demonstrably does a second job (it also signs,
    // or it is the session/JWT secret) — key separation is broken, which is
    // the defect Tallrig shipped. A dedicated secret hashed once is weaker
    // practice but not that bug: warning.
    const arg = upd[1].replace(/\s+as\s+\w+/, '').trim();
    const shared = SHARED_SECRET_NAME_RE.test(context + upd[1])
      || lines.some((l) => /createHmac\(/.test(l) && arg && l.includes(arg));
    out.push({
      rule: 'weak-kdf',
      line: i + 1,
      severity: shared ? 'error' : 'warning',
      message: shared
        ? `${relPath}:${i + 1} encryption key derived by hashing a secret that also signs/authenticates — no key separation, no salt, no work factor`
        : `${relPath}:${i + 1} encryption key derived by hashing a secret once — prefer HKDF with a salt and a purpose label`,
      suggestion: 'Derive with HKDF (crypto.hkdfSync, a salt and a purpose label such as "at-rest-v1") or scrypt; keep the at-rest key separate from the session-signing secret.',
    });
  }
  return out;
}

// A third-party client's raw error text handed to the customer (CWE-209):
// vendor names, configuration, internal ids ride along. Tallrig shipped it
// with its registrar client (TALLRIG-2026-030): a TRPCError whose message is
// the caught error's message, and a classified error picked for display
// (`err instanceof RegistrarError ? err.message : …`). A role check on the
// same line (`isOperator ? err.message : customerMessage(err)`) is the fix.
const TRPC_MESSAGE_RE = /\bmessage\s*:\s*([\w$]+)\.message\b/;
const CLASSIFIED_PICK_RE = /=\s*([\w$]+)\s+instanceof\s+([A-Z]\w*Error)\s*\?\s*\1\.message\b/;
const ROLE_GATE_RE = /\b(?:is|can)(?:Operator|Admin|Staff|Internal)\b\s*\?/;

function upstreamErrorLeak(relPath, lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line) || LOG_LINE_RE.test(line) || ROLE_GATE_RE.test(line)) continue;
    const inTrpcError = /new\s+TRPCError\s*\(/.test(lines.slice(Math.max(0, i - 4), i + 1).join('\n'));
    const trpc = inTrpcError && TRPC_MESSAGE_RE.exec(line);
    const pick = CLASSIFIED_PICK_RE.exec(line);
    if (!trpc && !pick) continue;
    out.push({
      rule: 'upstream-error-leak',
      line: i + 1,
      severity: 'warning',
      message: pick
        ? `${relPath}:${i + 1} a ${pick[2]}'s raw message is chosen for display — upstream wording, vendor names and configuration reach the customer`
        : `${relPath}:${i + 1} the caught error's raw message becomes the client-facing TRPCError message`,
      suggestion: 'Map the error to a customer sentence (customerMessageFor(err)); keep err.message for the server log or an operator-only field, and pass the original as `cause`.',
    });
  }
  return out;
}

// A plan / tier / entitlement resolver whose FALL-THROUGH answer is a paid
// tier: anyone the resolver does not recognise gets the paid entitlements.
// Tallrig shipped it (TALLRIG-2026-014): resolveDbPlanTier ended
// `return "pro"`, so a free-plan stranger got five databases.
const TIER_FN_RE = /\b(?:function\s+|(?:const|let)\s+)(\w*(?:Plan|Tier|Entitlement|Subscription)\w*)\s*(?:\(|=\s*(?:async\s*)?\()/;
const PAID_RETURN_RE = /^\s*return\s+['"`](pro|premium|enterprise|business|paid|team|plus)['"`]\s*;?\s*$/i;

function insecureDefaultTier(relPath, lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const head = TIER_FN_RE.exec(lines[i]);
    if (!head || isComment(lines[i])) continue;
    // Walk the function body; the LAST top-level return before the closing
    // brace is the fall-through answer.
    let depth = 0; let opened = false; let lastReturn = -1;
    for (let j = i; j < Math.min(lines.length, i + 60); j++) {
      for (const ch of lines[j]) { if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--; }
      if (opened && depth === 1 && /^\s*return\b/.test(lines[j])) lastReturn = j;
      if (opened && depth === 0) {
        const m = lastReturn >= 0 && PAID_RETURN_RE.exec(lines[lastReturn]);
        if (m) {
          out.push({
            rule: 'insecure-default-tier',
            line: lastReturn + 1,
            severity: 'warning',
            message: `${relPath}:${lastReturn + 1} ${head[1]}() falls through to the paid tier "${m[1]}" — anyone it does not recognise gets paid entitlements`,
            suggestion: 'Fall through to the free / least-privileged tier, and resolve paid tiers from the billing record (an active subscription), never from a default or an env override.',
          });
        }
        break;
      }
    }
  }
  return out;
}

// A request acting FOR A USER falls back to the PLATFORM's own credential
// when the user has none: the user reaches what only the platform should
// (confused deputy). Tallrig shipped it (TALLRIG-2026-024): no linked GitHub
// key → `new GitHubClient(boxGithubToken())`, so any caller could read
// whatever the box token could. Two shapes: `userCred ?? process.env.X_TOKEN`
// and `if (!row) return …(boxToken())` after a user-credential lookup.
const PLATFORM_TOKEN_RE = /\bprocess\.env\.[A-Z0-9_]*(?:TOKEN|API_KEY|PAT)\b|\b(?:box|platform|server|global|service|app|admin)[A-Z]\w*Token\s*\(/;
const USER_SCOPE_RE = /\buserId\b|\bctx\.user\b|\bsession\.user\b|\breq\.user\b|\bc\.get\(\s*['"]user['"]\s*\)|\bcurrentUser\b/;
const FALLBACK_RE = /(?:\?\?|\|\|)\s*(?:process\.env\.[A-Z0-9_]*(?:TOKEN|API_KEY|PAT)\b|(?:box|platform|server|global|service|app|admin)[A-Z]\w*Token\s*\()/;
const NO_ROW_FALLBACK_RE = /\bif\s*\(\s*!\s*[\w$.]+\s*\)\s*return\b/;

function ambientCredentialFallback(relPath, lines) {
  const out = [];
  if (OPERATOR_PATH_RE.test(String(relPath).replace(/\\/g, '/'))) return out;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line) || !PLATFORM_TOKEN_RE.test(line)) continue;
    const shape = FALLBACK_RE.test(line) || (NO_ROW_FALLBACK_RE.test(line) && PLATFORM_TOKEN_RE.test(line));
    if (!shape) continue;
    const context = lines.slice(Math.max(0, i - 12), i + 1).join('\n');
    if (!USER_SCOPE_RE.test(context)) continue;
    out.push({
      rule: 'ambient-credential-fallback',
      line: i + 1,
      severity: 'warning',
      message: `${relPath}:${i + 1} a request acting for a user falls back to the platform's own credential when the user has none — the user reaches what only the platform should (confused deputy)`,
      suggestion: "With no user credential, act anonymously (or refuse); never borrow the platform token. Allow-list the few admin-only callers explicitly.",
    });
  }
  return out;
}

/** All disclosure rules for one file. */
function scanDisclosure(relPath, content) {
  const lines = String(content).split(/\r?\n/);
  return [...urlCredentialParam(relPath, lines), ...errorDetailLeak(relPath, lines), ...weakKdf(relPath, lines), ...upstreamErrorLeak(relPath, lines), ...insecureDefaultTier(relPath, lines), ...ambientCredentialFallback(relPath, lines)];
}

module.exports = { scanDisclosure, urlCredentialParam, errorDetailLeak, weakKdf, upstreamErrorLeak, insecureDefaultTier, ambientCredentialFallback };
