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

// Where the reader IS the operator — a CLI, a maintenance script, an audit
// job, an admin-only route or an admin-named file — naming the variable to
// set is the right message.
const OPERATOR_PATH_RE = /(?:^|\/)(?:bin|scripts|cli|tools|audits)\/|\/admin\/|(?:^|\/)admin[-_][^/]*$/;

// The handler a line sits in is gated to operators: the nearest route or
// procedure head above it names an admin guard (Tallrig 2026-10-03:
// `app.post("/x", requireAdmin, …)` and `liveModels: adminProcedure.query(…)`).
const ROUTE_HEAD_RE = /\.(?:get|post|put|patch|delete|all)\s*\(\s*['"`]|\b[a-z]\w*Procedure\b/;
const ADMIN_GATE_RE = /\b(?:requireAdmin|requireOperator|requireSuperAdmin|adminProcedure|operatorProcedure|superAdminProcedure)\b/;
// A top-level function declaration ends the walk: a helper is not a handler,
// whatever route sits above it (and an import line names guards, not a gate).
const TOP_LEVEL_FN_RE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/;
function inAdminHandler(lines, i) {
  for (let j = i; j >= Math.max(0, i - 250); j--) {
    if (TOP_LEVEL_FN_RE.test(lines[j])) return false;
    if (isComment(lines[j]) || /^\s*import\b/.test(lines[j]) || !ROUTE_HEAD_RE.test(lines[j])) continue;
    return ADMIN_GATE_RE.test(lines.slice(j, j + 3).join(' '));
  }
  return false;
}

// An internal result object — a discriminated union a caller branches on
// (`{ ok: false, reason }`, `{ status: "failed", note }`, `{ action: "refuse",
// reason }`) — is a boot guard's or a helper's answer, not a response body.
// Tallrig 2026-10-03: master-keys, secret-key-guard, crypto, ops-agent-client.
const RESULT_DISCRIMINANT_RE = /\b(?:ok\s*:\s*(?:true|false)|status\s*:\s*['"`]|action\s*:\s*['"`])/;
function objectAround(lines, i) {
  let start = i;
  for (let j = i; j >= Math.max(0, i - 4); j--) { start = j; if (/\{\s*$|\{\s*\w/.test(lines[j]) && /\breturn\b|=\s*\{|\(\s*\{/.test(lines[j])) break; }
  let end = i;
  for (let j = i; j < Math.min(lines.length, i + 5); j++) { end = j; if (/^\s*\}/.test(lines[j]) || /\}\s*\)?;?\s*$/.test(lines[j])) break; }
  return lines.slice(start, end + 1).join('\n');
}
// …unless it is handed to a response, or carries an HTTP status for one
// (`{ ok: false, status: 503, error }` is what a door answers with).
const HTTP_STATUS_FIELD_RE = /\bstatus\s*:\s*[1-5]\d\d\b/;
function isInternalResult(lines, i) {
  const obj = objectAround(lines, i);
  const near = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
  return RESULT_DISCRIMINANT_RE.test(obj) && !HTTP_STATUS_FIELD_RE.test(obj) && !RESPONSE_SINK_RE.test(near);
}

function wordIn(name, text) {
  let at = text.indexOf(name);
  while (at !== -1) {
    const before = at === 0 ? '' : text[at - 1];
    const after = text[at + name.length] || '';
    if (!/[\w$]/.test(before) && !/[\w$]/.test(after)) return true;
    at = text.indexOf(name, at + 1);
  }
  return false;
}

// The classes an `instanceof` guards within the last few lines, other than
// plain Error: `if (err instanceof CronParseError) return c.json({ error:
// err.message })` returns text the code itself wrote.
const INSTANCEOF_RE = /\binstanceof\s+([A-Z][\w$]*)/g;
function guardedClasses(lines, i, back = 3) {
  const text = lines.slice(Math.max(0, i - back), i + 1).join('\n');
  return [...text.matchAll(INSTANCEOF_RE)].map((m) => m[1]);
}
function typedErrorGuard(lines, i) {
  const classes = guardedClasses(lines, i);
  return classes.length > 0 && classes.every((c) => c !== 'Error');
}

// An explicit suppression on the line or the line above, for a surface the
// rule cannot see is internal (a loopback-only service).
const LEAK_OK_RE = /\berror-detail-ok\b/;

function errorDetailLeak(relPath, lines) {
  const out = [];
  if (OPERATOR_PATH_RE.test(String(relPath).replace(/\\/g, '/'))) return out;
  const throwsEnvName = lines.some((l) => !isComment(l) && THROW_ENV_RE.test(l) && ENV_NAME_RE.test(l))
    || lines.some((l, i) => !isComment(l) && THROW_ENV_RE.test(l) && ENV_NAME_RE.test(lines.slice(i, i + 3).join(' ')));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line) || LOG_LINE_RE.test(line)) continue;
    if (LEAK_OK_RE.test(line) || (i > 0 && LEAK_OK_RE.test(lines[i - 1]))) continue;
    const facing = FACING_KEY_RE.exec(line);
    if (facing && ENV_NAME_RE.test(line.slice(facing.index))) {
      const tail = line.slice(facing.index);
      const name = tail.match(ENV_NAME_RE)[0];
      // "(e.g. RESEND_API_KEY)" is an example of a key's shape, not this server's configuration.
      if (/\be\.g\.\s*[A-Z]/.test(tail) && tail.indexOf(name) > tail.search(/\be\.g\./)) continue;
      if (isInternalResult(lines, i) || inAdminHandler(lines, i)) continue;
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
      const windowLines = lines.slice(i, i + 4);
      // `const message = err.message` leaks only if a response uses `message`
      // (Tallrig's OAuth start logged it and redirected with a constant).
      const bound = /\b(?:const|let|var)\s+([\w$]+)\s*=/.exec(line);
      const sinkLine = windowLines.find((l, k) => RESPONSE_SINK_RE.test(l) && (!bound || k === 0 || wordIn(bound[1], l)));
      if (!sinkLine || LOG_LINE_RE.test(sinkLine)) continue;
      if (typedErrorGuard(lines, i) || inAdminHandler(lines, i)) continue;
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

// A caught error, by name or by its `catch (x)` binding — not `result.message`
// of a value the code built (Tallrig: `message: claimable.message`).
const ERROR_IDENT_RE = /^(?:err|error|e|ex|cause|caught)$/;
function isCaughtError(name, lines, i) {
  if (ERROR_IDENT_RE.test(name)) return true;
  const back = lines.slice(Math.max(0, i - 12), i + 1).join('\n');
  return [...back.matchAll(/\bcatch\s*\(\s*([\w$]+)/g)].some((m) => m[1] === name);
}
const SANITISE_CALL_RE = /\b\w*(?:safe|saniti[sz]e|redact|scrub)\w*\s*\(/i;

/**
 * Repo-wide facts the upstream rule needs, from every scanned file:
 *   curatedErrors   error classes defined here whose every construction is
 *                   the code's own sentence — no response body, vendor detail
 *                   or caught message interpolated (Tallrig: ConferenceError,
 *                   ComposeError; CarrierError builds from the vendor body)
 *   scrubsInternal  a tRPC errorFormatter replaces INTERNAL_SERVER_ERROR
 *                   messages that carry a cause
 * Without it (a single file, a unit test) the rule judges the file alone.
 */
const ERROR_CLASS_RE = /\bclass\s+([A-Z][\w$]*)\s+extends\s+[\w$.]*Error\b/g;
const UPSTREAM_TEXT_RE = /\$\{[^}]*\b(?:message|detail|details|body|text|snippet|responseText|raw)\b|(?<![\w$.])(?:err|error|e|cause)\.message\b|\+\s*[\w$.]*\b(?:message|detail|body|text)\b/;
// The argument text of the call that opens `text`, up to its balanced `)`.
function callArgs(text) {
  const open = text.indexOf('(');
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === '(') depth++;
    else if (text[k] === ')' && --depth === 0) return text.slice(open, k + 1);
  }
  return text.slice(open);
}
function buildDisclosureContext(files) {
  const defined = new Set();
  const leaky = new Set();
  let scrubsInternal = false;
  for (const { content } of files) {
    const text = String(content);
    const lines = text.split(/\r?\n/);
    for (const m of text.matchAll(ERROR_CLASS_RE)) defined.add(m[1]);
    for (let i = 0; i < lines.length; i++) {
      const cls = /\bclass\s+([A-Z][\w$]*)\s+extends\s+[\w$.]*Error\b/.exec(lines[i]);
      if (cls && lines.slice(i, i + 15).some((l) => /\bsuper\s*\(/.test(l) && UPSTREAM_TEXT_RE.test(l))) leaky.add(cls[1]);
      for (const m of lines[i].matchAll(/\bnew\s+([A-Z][\w$]*)\s*\(/g)) {
        const call = callArgs([lines[i].slice(m.index), ...lines.slice(i + 1, i + 6)].join('\n'));
        // Words inside a plain string are the code's own sentence ("…an HTML body").
        const code = call.replace(/(['"])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
        if (UPSTREAM_TEXT_RE.test(call) || /\b(?:detail|body|responseText)\b/.test(code)) leaky.add(m[1]);
      }
      if (/\berrorFormatter\b/.test(lines[i]) && lines.slice(i, i + 12).some((l) => /INTERNAL_SERVER_ERROR/.test(l) && /\bcause\b/.test(l))) scrubsInternal = true;
    }
  }
  const curatedErrors = new Set([...defined].filter((c) => !leaky.has(c)));
  return { curatedErrors, scrubsInternal };
}

function upstreamErrorLeak(relPath, lines, ctx = null) {
  const out = [];
  const curated = (classes) => ctx && classes.length > 0 && classes.every((c) => ctx.curatedErrors.has(c));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line) || LOG_LINE_RE.test(line) || ROLE_GATE_RE.test(line)) continue;
    const trpcStart = lines.slice(Math.max(0, i - 4), i + 1).findIndex((l) => /new\s+TRPCError\s*\(/.test(l));
    const trpcMatch = trpcStart !== -1 && TRPC_MESSAGE_RE.exec(line);
    const trpc = trpcMatch && isCaughtError(trpcMatch[1], lines, i) ? trpcMatch : null;
    const pickMatch = CLASSIFIED_PICK_RE.exec(line);
    const pick = pickMatch && pickMatch[2] !== 'TRPCError' ? pickMatch : null;
    if (!trpc && !pick) continue;
    if (inAdminHandler(lines, i)) continue;
    if (pick) {
      if (curated([pick[2]])) continue;
      if (SANITISE_CALL_RE.test(lines.slice(i + 1, i + 4).join('\n'))) continue;
    }
    if (trpc) {
      if (curated(guardedClasses(lines, i, 6).filter((c) => c !== 'TRPCError'))) continue;
      const block = lines.slice(Math.max(0, i - 4) + trpcStart, i + 4).join('\n');
      if (ctx && ctx.scrubsInternal && /INTERNAL_SERVER_ERROR/.test(block) && /\bcause\s*[:,}]/.test(block)) continue;
    }
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
function scanDisclosure(relPath, content, ctx = null) {
  const lines = String(content).split(/\r?\n/);
  return [...urlCredentialParam(relPath, lines), ...errorDetailLeak(relPath, lines), ...weakKdf(relPath, lines), ...upstreamErrorLeak(relPath, lines, ctx), ...insecureDefaultTier(relPath, lines), ...ambientCredentialFallback(relPath, lines)];
}

module.exports = { scanDisclosure, buildDisclosureContext, urlCredentialParam, errorDetailLeak, weakKdf, upstreamErrorLeak, insecureDefaultTier, ambientCredentialFallback };
