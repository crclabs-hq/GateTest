'use strict';

/**
 * Access-scope rules — built against Tallrig's bug corpus (docs/cross-test
 * in gluecron.com/ccantynz/tallrig; scored by scripts/cross-test-score.js).
 * Two defect classes GateTest missed on 2026-10-02:
 *
 *   unscoped-lookup        a record is chosen from EVERY tenant's rows
 *                          (`matchZone(await db.listZones(), name)`) and the
 *                          function goes on to return or act on it with no
 *                          ownership / allowlist predicate anywhere after the
 *                          lookup (TALLRIG-2026-010: an ACME TXT write into any
 *                          customer's zone)
 *   soft-state-unfiltered  a query by a natural key (domain, host, slug)
 *                          that SELECTS the row's soft-state column (status,
 *                          removedAt, deletedAt) but neither filters on it in
 *                          the `where` nor tests it afterwards — a removed
 *                          domain keeps routing (TALLRIG-2026-028)
 *
 * Both are warnings: they are shapes, not proofs, and the fix is a predicate
 * the reviewer can confirm in a line. Pure: (relPath, content) → findings,
 * read on masked source so a comment that says "removed" or "owner" is not a
 * predicate. Control pairs in tests/access-scope-rules.test.js — the corpus's
 * own fixed code is the "must stay quiet" half.
 */

const { maskSource } = require('./source-strip');

const WINDOW = 40;

// A helper handed the WHOLE collection: `matchZone(await db.listZones(), name)`,
// or the collection searched in place: `(await db.listZones()).find(...)`.
const LIST_ALL_ARG_RE = /\b[A-Za-z_$][\w$]*\s*\(\s*await\s+[\w$.]+\.(?:list|getAll|findAll|all)[A-Z]?\w*\(\s*\)\s*,/;
const LIST_ALL_FIND_RE = /\(\s*await\s+[\w$.]+\.(?:list|getAll|findAll|all)[A-Z]?\w*\(\s*\)\s*\)\s*\.(?:find|filter)\s*\(/;
// Evidence the function scopes the match to the caller.
const SCOPE_RE = /\b(?:allow\w*|Allow\w*|permit\w*|Permit\w*|owner\w*|Owner\w*|tenant\w*|Tenant\w*|userId|orgId|accountId|workspaceId|projectId|scope\w*|Scope\w*|authori[sz]\w*|Authori[sz]\w*|canAccess|requireOwned|assertOwn\w*)\b|\.has\s*\(/;

/** The lines from `start` to the end of the enclosing block (≤ WINDOW). */
function restOfBlock(masked, start) {
  const out = [];
  let depth = 0;
  for (let k = start; k < Math.min(masked.length, start + WINDOW); k += 1) {
    const line = masked[k];
    out.push(line);
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth < 0) return out; }
    }
  }
  return out;
}

function unscopedLookup(relPath, masked) {
  const findings = [];
  masked.forEach((line, i) => {
    if (!LIST_ALL_ARG_RE.test(line) && !LIST_ALL_FIND_RE.test(line)) return;
    const after = restOfBlock(masked, i).join('\n');
    if (SCOPE_RE.test(after)) return;
    findings.push({
      rule: 'unscoped-lookup',
      line: i + 1,
      severity: 'warning',
      message: `${relPath}:${i + 1} picks a record out of every tenant's rows and acts on it with no ownership or allowlist check after the lookup — a caller can reach a record that is not theirs`,
      suggestion: 'Scope the lookup to the caller (list only their rows), or refuse after the match unless the record is on an allowlist / owned by the caller (403).',
    });
  });
  return findings;
}

// `.where(eq(t.domain, host))` — a lookup by a natural key.
const NATURAL_KEY_WHERE_RE = /\.where\s*\(.*\beq\s*\(\s*[\w$.]+\.(?:domain|host|hostname|slug|subdomain)\s*,/;
const SOFT_STATE_COL_RE = /\b(?:status|removedAt|deletedAt|removed_at|deleted_at|archivedAt|disabledAt)\s*:/;
const SOFT_STATE_PRED_RE = /\b(?:status|removed\w*|deleted\w*|archived\w*|disabled\w*|isNull|isNotNull)\b|\bne\s*\(/i;
const SOFT_STATE_TEST_RE = /\.(?:status|removedAt|deletedAt|archivedAt|disabledAt)\b\s*(?:[!=]==?|\)|&&|\|\||\?)|\b(?:status|removedAt|deletedAt)\s*[!=]==/;

function softStateUnfiltered(relPath, masked) {
  const findings = [];
  masked.forEach((line, i) => {
    if (!NATURAL_KEY_WHERE_RE.test(line)) return;
    // The where clause: this line until the chain moves on or the statement ends.
    let where = line.slice(line.indexOf('.where'));
    for (let k = i + 1; k < Math.min(masked.length, i + 6); k += 1) {
      if (/;\s*$/.test(masked[k - 1]) || /^\s*\.(?:limit|orderBy|offset|then|groupBy)\b/.test(masked[k])) break;
      where += `\n${masked[k]}`;
    }
    if (SOFT_STATE_PRED_RE.test(where.replace(/\beq\s*\(\s*[\w$.]+\.(?:domain|host|hostname|slug|subdomain)\s*,[^)]*\)/, ''))) return;
    // The projection above, back to `.select(`.
    let selected = '';
    for (let k = i; k >= Math.max(0, i - 25); k -= 1) {
      selected = `${masked[k]}\n${selected}`;
      if (/\.select\s*\(/.test(masked[k])) break;
    }
    if (!/\.select\s*\(/.test(selected) || !SOFT_STATE_COL_RE.test(selected)) return;
    const later = masked.slice(i + 1, i + 26).join('\n');
    if (SOFT_STATE_TEST_RE.test(later)) return;
    findings.push({
      rule: 'soft-state-unfiltered',
      line: i + 1,
      severity: 'warning',
      message: `${relPath}:${i + 1} looks a row up by its domain/host/slug and reads its soft-state column, but neither the where clause nor the code after it tests that column — a removed or disabled row still matches`,
      suggestion: 'Add the soft-state predicate to the where clause (`ne(t.status, "removed")` / `isNull(t.deletedAt)`), or refuse the row explicitly after the lookup.',
    });
  });
  return findings;
}


// ── client-identity-header (TALLRIG-2026-053) ───────────────────────────
// An identity the server enforces on (tenant / user / org / account id) read
// from a header the CLIENT sets: `c.req.header("x-tenant-id")`,
// `req.headers["x-user-id"]`, `headers.get("x-org-id")`. Any caller can name
// any tenant — its own rate-limit bucket, another tenant's limits, another
// user's data. Read on the RAW line (the header name is inside quotes).
const IDENTITY_HEADER_RE = /(?:\.header\(\s*|\.headers\.get\(\s*|\.headers\[\s*|\.get\(\s*)["'`](x-(?:tenant|user|org|organization|account|customer|workspace|team|owner|principal)-id)["'`]/i;
// The value is verified, not trusted: an HMAC / signature / JWT check nearby.
const VERIFIED_NEAR_RE = /\b(?:verify\w*|Verify\w*|hmac|Hmac|HMAC|timingSafeEqual|signature|Signature|jwt|Jwt|JWT|internalToken|INTERNAL_\w*SECRET)\b/;

const OPTIONAL_VERIFIER_RE = /\bif\s*\(\s*(?:[\w$]+\s*\.\s*)*[\w$]*(?:verify|Verify)\w*\s*\)/;

function clientIdentityHeader(relPath, masked) {
  const raw = masked.raw;
  const findings = [];
  const hits = [];
  raw.forEach((line, i) => {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
    const m = line.match(IDENTITY_HEADER_RE);
    if (!m) return;
    const near = masked.slice(Math.max(0, i - 6), i + 7).join('\n');
    // A verifier that only runs when it was supplied — `if (deps.verifyBearer)
    // { … }` — is skipped wherever it is not, so it verifies nothing there
    // (TALLRIG-2026-055: the production factory never passed one). The
    // fail-closed form `if (!verify) return 503` is a real check.
    if (VERIFIED_NEAR_RE.test(near) && !OPTIONAL_VERIFIER_RE.test(near)) return;
    hits.push({ line: i + 1, header: m[1] });
  });
  // One finding per file: the trust decision is the file's, not each read's.
  if (hits.length) {
    const { line, header } = hits[0];
    const more = hits.length > 1 ? ` (and ${hits.length - 1} more read${hits.length > 2 ? 's' : ''} in this file)` : '';
    findings.push({
      rule: 'client-identity-header',
      line,
      severity: 'warning',
      message: `${relPath}:${line} takes the caller's identity from the \`${header}\` request header${more} — the client sets it, so any caller can claim any ${header.replace(/^x-|-id$/gi, '')} (its rate-limit bucket, its limits, its data) unless a proxy you control overwrites it`,
      suggestion: 'Derive the identity from what the server authenticated (session, verified key, signed token). If a gateway you control always overwrites this header, say so where it is read.',
    });
  }
  return findings;
}

// ── wildcard-bind (TALLRIG-2026-059) ────────────────────────────────────
// A Bun / Hono server object with a port and no hostname: `Bun.serve({ port,
// fetch })`, `serve({ fetch, port })`, `export default { port, fetch }`. Bun
// and @hono/node-server default to EVERY interface, so a service meant for
// loopback (an internal proxy with no auth of its own) answers on whatever
// network the host is on. Plain `app.listen(port)` is not judged: binding
// all interfaces is the normal container shape for a public app.
const SERVE_OPEN_RE = /\b(?:Bun\s*\.\s*serve|[\w$]+\s*\.\s*serve|serve)\s*\(\s*\{|\bexport\s+default\s+\{/;

function wildcardBind(relPath, masked) {
  const findings = [];
  masked.forEach((line, i) => {
    const m = SERVE_OPEN_RE.exec(line);
    if (!m) return;
    let depth = 0;
    const body = [];
    // Brace-matched to the end of the options object; the cap only guards a
    // runaway. 40 lines missed comms-intelligence's `hostname` after a long
    // inline fetch/websocket object (Tallrig, 2026-10-03).
    for (let k = i; k < masked.length && k <= i + 400; k += 1) {
      const ln = k === i ? masked[k].slice(m.index) : masked[k];
      body.push(ln);
      for (const ch of ln) { if (ch === '{') depth += 1; else if (ch === '}') depth -= 1; }
      if (depth <= 0) break;
    }
    const obj = body.join('\n');
    if (!/\bport\b/.test(obj) || !/\bfetch\b/.test(obj)) return;
    if (/\b(?:hostname|host)\b/.test(obj)) return;
    // A spread (`...resolveApiBindOptions()`) may carry the hostname: not judged.
    if (/\.\.\./.test(obj)) return;
    findings.push({
      rule: 'wildcard-bind',
      line: i + 1,
      severity: 'warning',
      message: `${relPath}:${i + 1} starts a server with a port and no hostname — Bun and @hono/node-server then bind every interface, so a service meant for loopback is reachable from the host's network (inside a container whose port mapping is the exposure, this is expected)`,
      suggestion: 'Pass `hostname` explicitly — an env-overridable value defaulting to "127.0.0.1" for an internal service, `"0.0.0.0"` only where exposure is intended and authenticated.',
    });
  });
  return findings;
}

// ── unowned-route-pool (TALLRIG-2026-050) ───────────────────────────────
// A resolver that loads EVERY tenant's routes / domains / aliases, filtered
// only by an enabled flag, and picks one for an address or host — so a tenant
// that writes a route for someone else's domain can win it. Ownership proof
// (a verified-domain join, an owner/tenant predicate) is what is missing.
const ROUTE_TABLE_RE = /\.from\(\s*(\w*(?:[Rr]outes?|[Dd]omains?|[Aa]liases|[Mm]appings?|[Cc]laims?|[Hh]ostnames?|[Rr]edirects?)\w*)\s*\)/;
const OWNERSHIP_RE = /\b(?:\w*[Vv]erified\w*|\w*[Oo]wner\w*|\w*[Tt]enant\w*|userId|orgId|accountId|\w*[Oo]wnership\w*)\b/;

function unownedRoutePool(relPath, masked) {
  const findings = [];
  masked.forEach((line, i) => {
    const t = line.match(ROUTE_TABLE_RE);
    if (!t) return;
    // The function this select lives in must resolve an address / host.
    const head = masked.slice(Math.max(0, i - 8), i + 1).join('\n');
    if (!/\b(?:address|host|hostname|domain|email|recipient|sni|fqdn)\b/i.test(head)) return;
    // The where clause: next few lines up to the end of the statement.
    let where = '';
    for (let k = i; k < Math.min(masked.length, i + 6); k += 1) {
      where += `${masked[k]}\n`;
      if (/;\s*$/.test(masked[k])) break;
    }
    if (!/\.where\(/.test(where)) return;
    const pred = where.slice(where.indexOf('.where('));
    if (OWNERSHIP_RE.test(pred)) return;
    // The ONLY condition is a soft-state flag: no `and(`, no match on a key.
    const cond = pred.replace(/^\.where\(\s*/, '').replace(/\)\s*;?\s*[\s\S]*$/, ')');
    if (!/^(?:isNull|isNotNull|eq|ne)\s*\(\s*[\w$.]+\.(?:disabledAt|deletedAt|enabled|active|isActive|isEnabled)\b[^()]*\)$/.test(cond.trim())) return;
    // …and the pool is then matched against an address / host.
    const later = masked.slice(i, i + 25).join('\n');
    if (!/\b(?:match\w*|Match\w*|pick\w*|select\w*Route|resolve\w*)\s*\([^)]*\b(?:address|host|hostname|domain|email|recipient)\b|\.find\([^)]*\b(?:address|host|hostname|domain)\b/.test(later)) return;
    // Ownership could still be checked after the pool is loaded.
    const after = masked.slice(i, i + 30).join('\n');
    if (/\b(?:verified\w*|Verified\w*|ownership\w*|Ownership\w*|proveOwnership|domainVerified)\b/.test(after)) return;
    findings.push({
      rule: 'unowned-route-pool',
      line: i + 1,
      severity: 'warning',
      message: `${relPath}:${i + 1} picks a \`${t[1]}\` row for an address/host out of every tenant's enabled rows — nothing proves the winning tenant controls that domain, so one tenant can route another's traffic or mail to itself`,
      suggestion: 'Gate candidacy on proof of ownership (join the verified-domain table, or require the route\'s domain to be verified for its tenant) before matching.',
    });
  });
  return findings;
}

function scanAccessScope(relPath, content) {
  const masked = maskSource(String(content), relPath).split(/\r?\n/);
  masked.raw = String(content).split(/\r?\n/);
  return [
    ...unscopedLookup(relPath, masked),
    ...softStateUnfiltered(relPath, masked),
    ...clientIdentityHeader(relPath, masked),
    ...wildcardBind(relPath, masked),
    ...unownedRoutePool(relPath, masked),
  ];
}

module.exports = { scanAccessScope, unscopedLookup, softStateUnfiltered, clientIdentityHeader, unownedRoutePool, wildcardBind };
