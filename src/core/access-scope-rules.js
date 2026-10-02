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

function scanAccessScope(relPath, content) {
  const masked = maskSource(String(content), relPath).split(/\r?\n/);
  return [...unscopedLookup(relPath, masked), ...softStateUnfiltered(relPath, masked)];
}

module.exports = { scanAccessScope, unscopedLookup, softStateUnfiltered };
