'use strict';

/**
 * Account-state rules: the doors that decide whether a credential still
 * opens anything. Built against Tallrig's bug corpus (entries 043-046, added
 * 2026-10-02 from real fix commits; scored by scripts/cross-test-score.js):
 *
 *   identifier-as-credential  an auth function decodes an (id, secret) pair
 *                             and succeeds having read only the id; the
 *                             secret is never compared (TALLRIG-2026-043:
 *                             any secret opened any account by user id)
 *   deny-list-status          a gate written as `status === "suspended"` /
 *                             `!== "suspended"` in auth code; a column with
 *                             more shut-off states (offboarded, removed)
 *                             fails open on every one it does not name
 *                             (TALLRIG-2026-044)
 *   key-door-owner-unchecked  a key/token lookup checks the key row (expiry,
 *                             revocation) and sets the request principal
 *                             from `key.userId` without reading the owner's
 *                             blocked state (TALLRIG-2026-045)
 *   suspend-keeps-keys        a suspend/disable handler writes the blocked
 *                             flag and deletes sessions but revokes no other
 *                             credential kind (TALLRIG-2026-046)
 *
 * All warnings — each names the predicate to add — read on masked source so
 * comments and strings are not evidence. Pure: (relPath, content) → findings.
 * Control pairs in tests/account-state-rules.test.js.
 */

const { maskSource } = require('./source-strip');

const AUTH_PATH_RE = /(?:^|\/)[^/]*(?:auth|credential|session|api-key|apikey|token|login|middleware|vendor)[^/]*(?:\/|\.[jt]sx?$)/i;
const SHUT_OFF = 'suspended|disabled|banned|blocked|deactivated|inactive';

/** Function-sized windows: from each line that opens a function to its closing brace. */
function functionBodies(masked) {
  const out = [];
  const OPEN_RE = /\b(?:async\s+)?function\b[^(]*\(|=>\s*\{\s*$|\b(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::[^{]*)?\{\s*$|\.(?:mutation|query|use)\s*\(\s*async\b/;
  for (let i = 0; i < masked.length; i += 1) {
    if (!OPEN_RE.test(masked[i])) continue;
    let depth = 0;
    let seen = false;
    for (let k = i; k < Math.min(masked.length, i + 120); k += 1) {
      for (const ch of masked[k]) {
        if (ch === '{') { depth += 1; seen = true; } else if (ch === '}') depth -= 1;
      }
      if (seen && depth <= 0) { out.push({ start: i, end: k }); break; }
    }
  }
  return out;
}

function identifierAsCredential(relPath, masked) {
  const findings = [];
  masked.forEach((line, i) => {
    const m = line.match(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:decodeBasic|parseBasic\w*|basicAuth\w*|decodeBasicAuth|parseAuthorization\w*)\s*\(/);
    if (!m) return;
    const v = m[1];
    const rest = masked.slice(i + 1, i + 60).join('\n');
    const end = rest.search(/\n\}\s*$/m);
    const body = end > 0 ? rest.slice(0, end) : rest;
    const readsId = new RegExp(`\\b${v}\\.(?:user|username|id|keyId|accessKey|name)\\b`).test(body);
    const readsSecret = new RegExp(`\\b${v}\\.(?:secret|password|pass|token|key)\\b|\\{[^}]*\\b(?:secret|password|pass)\\b[^}]*\\}\\s*=\\s*${v}\\b`).test(body);
    const succeeds = /\bok\s*:\s*true\b|\breturn\s+[A-Za-z_$][\w$]*\s*;|\buserId\s*[,}]/.test(body);
    if (readsId && !readsSecret && succeeds) {
      findings.push({
        rule: 'identifier-as-credential',
        line: i + 1,
        severity: 'warning',
        message: `${relPath}:${i + 1} decodes an id/secret pair into \`${v}\` and authenticates from the id alone — the secret half is never checked, so knowing an account id is enough to act as it`,
        suggestion: 'Verify the secret (hash and compare, or resolve the key from it) and require it to belong to the same account as the id before returning success.',
      });
    }
  });
  return findings;
}

function denyListStatus(relPath, masked) {
  if (!AUTH_PATH_RE.test(relPath)) return [];
  const re = new RegExp(`\\.status\\s*(?:===|!==|==|!=)\\s*["'\`](?:${SHUT_OFF})["'\`]|["'\`](?:${SHUT_OFF})["'\`]\\s*(?:===|!==|==|!=)\\s*[\\w$.]+\\.status\\b`);
  const findings = [];
  masked.forEach((line, i) => {
    // Masking blanks string contents, so read the literal from the raw text
    // only where the masked line has the comparison shape.
    if (!/\.status\s*(?:===|!==|==|!=)\s*["'`]/.test(line) && !/["'`]\s*(?:===|!==|==|!=)\s*[\w$.]+\.status\b/.test(line)) return;
    if (!re.test(masked.raw[i])) return;
    findings.push({
      rule: 'deny-list-status',
      line: i + 1,
      severity: 'warning',
      message: `${relPath}:${i + 1} gates access on one named shut-off status — every other blocked state the column can hold (offboarded, removed, …) is let through`,
      suggestion: 'Allow-list the states that may authenticate (`["active", "provisioning"].includes(status)`) in one shared predicate, so a new blocked state fails closed.',
    });
  });
  return findings;
}

const OWNER_STATE_RE = /\b(?:suspend\w*|Suspend\w*|removed\w*|Removed\w*|blocked\w*|Blocked\w*|disabled\w*|deactivat\w*|accountBlock\w*|isUser\w*|userState|ownerState|isActive\w*|banned\w*)\b/;

function keyDoorOwnerUnchecked(relPath, masked) {
  const findings = [];
  // The file as a whole is the last window: a middleware body is often an
  // arrow passed straight to `app.use(...)`, or a fragment with no opener.
  for (const { start, end } of [...functionBodies(masked), { start: 0, end: masked.length - 1 }]) {
    const body = masked.slice(start, end + 1);
    const text = body.join('\n');
    const keyVar = (text.match(/\b([A-Za-z_$][\w$]*)\.(?:expiresAt|revokedAt|expires_at|revoked_at)\b/) || [])[1];
    if (!keyVar) continue;
    const setAt = body.findIndex((l) => new RegExp(`(?:\\.set\\(\\s*["'\`]userId["'\`]\\s*,|\\buserId\\s*[:=])\\s*${keyVar}\\.(?:userId|ownerId|user_id|owner_id)\\b`).test(l)
      // masking blanks the key name inside `c.set("userId", …)`; any quoted key counts
      || new RegExp(`\\.set\\(\\s*["'\`][^"'\`]*["'\`]\\s*,\\s*${keyVar}\\.(?:userId|ownerId)\\b`).test(l));
    if (setAt < 0) continue;
    if (OWNER_STATE_RE.test(text)) continue;
    const line = start + setAt + 1;
    if (findings.some((f) => f.line === line)) continue;
    findings.push({
      rule: 'key-door-owner-unchecked',
      line,
      severity: 'warning',
      message: `${relPath}:${line} authenticates as \`${keyVar}.userId\` after checking only the key row — a suspended or removed owner's key still opens every door it reaches`,
      suggestion: 'Check the owner\'s blocked-account state (suspended / removed) through the same shared predicate the session door uses, before setting the principal.',
    });
  }
  return findings;
}

function suspendKeepsKeys(relPath, masked) {
  const findings = [];
  for (const { start, end } of functionBodies(masked)) {
    const body = masked.slice(start, end + 1);
    const text = body.join('\n');
    const flagAt = body.findIndex((l) => /\.set\(\s*\{[^}]*\b(?:suspendedAt|disabledAt|deactivatedAt|bannedAt|suspended|disabled)\s*:/.test(l));
    if (flagAt < 0) continue;
    if (!/\.delete\(\s*sessions\b|deleteSessions?\w*\(|revokeSessions?\w*\(/.test(text)) continue;
    if (/\b(?:api_?[Kk]eys?|[A-Za-z]*Keys?|tokens?|Tokens?|credentials?|Credentials?)\b(?![^(]*sessions)/.test(text.replace(/\.delete\(\s*sessions\b[^\n]*/g, '').replace(/\bsessions?\w*/gi, ''))) continue;
    const line = start + flagAt + 1;
    findings.push({
      rule: 'suspend-keeps-keys',
      line,
      severity: 'warning',
      message: `${relPath}:${line} suspends an account and revokes its sessions, but no other credential kind — API keys and tokens issued to it keep working`,
      suggestion: 'Revoke every credential kind the account owns (API keys, platform keys, OAuth tokens) in the same handler, or make every key door refuse a suspended owner.',
    });
  }
  return findings;
}

// ── unset-credential-allows (TALLRIG-2026-054) ──────────────────────────
// An auth check whose "credential not configured" branch lets the request
// through on any path: `const expected = process.env.X_API_KEY; if (!expected)
// { if (NODE_ENV === "production") return error; return next(); }`. Whether
// auth runs then keys on an environment label, not on the credential, and a
// box with NODE_ENV unset serves every caller. A missing credential must be
// an error in every environment. Read on the RAW line (the bracketed key is
// a string) for the binding, on the masked lines for the block.
const CREDENTIAL_ENV_BINDING_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*process\.env(?:\.|\[\s*["'`])([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)/;
const LETS_THROUGH_RE = /\bnext\s*\(\s*\)|\breturn\s+true\b/;

function unsetCredentialAllows(relPath, masked) {
  const raw = masked.raw;
  const findings = [];
  raw.forEach((line, i) => {
    const b = CREDENTIAL_ENV_BINDING_RE.exec(line);
    if (!b) return;
    const name = b[1].replace(/\$/g, '\\$');
    const guard = new RegExp(`\\bif\\s*\\(\\s*!\\s*${name}\\s*\\)\\s*\\{`);
    for (let j = i + 1; j <= i + 8 && j < masked.length; j += 1) {
      if (!guard.test(masked[j] || '')) continue;
      // The guarded block, by brace depth on the masked lines.
      let depth = 0;
      const body = [];
      for (let k = j; k < masked.length && k <= j + 30; k += 1) {
        const ln = masked[k] || '';
        body.push(ln);
        for (const ch of ln) { if (ch === '{') depth += 1; else if (ch === '}') depth -= 1; }
        if (depth <= 0 && k > j) break;
        if (depth <= 0 && /\}/.test(ln.slice(ln.indexOf('{') + 1))) break;
      }
      if (LETS_THROUGH_RE.test(body.join('\n'))) {
        findings.push({
          rule: 'unset-credential-allows',
          line: j + 1,
          severity: 'warning',
          message: `${relPath}:${j + 1} lets the request through when \`${b[2]}\` is not configured — whether auth runs depends on the environment, not on the credential, so a box with it unset serves every caller`,
          suggestion: 'Refuse (503) when the credential is unset, in every environment. Give tests and local dev a real test credential instead of a bypass.',
        });
      }
      return;
    }
  });
  return findings;
}

function scanAccountState(relPath, content) {
  const raw = String(content).split(/\r?\n/);
  const masked = maskSource(String(content), relPath).split(/\r?\n/);
  masked.raw = raw;
  return [
    ...identifierAsCredential(relPath, masked),
    ...denyListStatus(relPath, masked),
    ...keyDoorOwnerUnchecked(relPath, masked),
    ...suspendKeepsKeys(relPath, masked),
    ...unsetCredentialAllows(relPath, masked),
  ];
}

module.exports = { scanAccountState, identifierAsCredential, denyListStatus, keyDoorOwnerUnchecked, suspendKeepsKeys, unsetCredentialAllows };
