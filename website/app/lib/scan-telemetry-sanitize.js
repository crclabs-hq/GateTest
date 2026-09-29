'use strict';
/**
 * Pure sanitizer for incoming scan-telemetry records — the defense-in-depth
 * PII guard for POST /api/telemetry/scan. Kept as plain JS (no db import) so it
 * is unit-testable directly from node --test AND importable by the TS store
 * (scan-telemetry-store.ts).
 *
 * The recorder (src/core/scan-telemetry.js) already strips PII at source; this
 * is the second wall: any record carrying a path/content/message-shaped key is
 * REJECTED outright rather than trusted.
 */

const MAX_MODULE_LEN = 100;
const MAX_SOURCE_LEN = 20;
const MAX_SUITE_LEN = 30;
const MAX_MODULES_PER_RECORD = 200;
const MAX_RULES_PER_RECORD = 400;
const MAX_RULE_LEN = 120;
// A rule id is `module:rule[:qualifier]` — identifier characters only. A slash,
// a backslash or whitespace means a path or text leaked past the recorder.
const RULE_ID_RE = /^[A-Za-z0-9_.:@*-]{1,120}$/;

// Keys that must NEVER appear on an anonymized record. Their presence means a
// malformed or hostile client, so the whole record is rejected.
const FORBIDDEN_KEYS = new Set([
  'file', 'path', 'filepath', 'filePath', 'content', 'code', 'snippet',
  'repo', 'repoUrl', 'repository', 'url', 'message', 'detail', 'line',
]);

function clampStr(s, max) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  return t.replace(/[/\\]/g, '-').slice(0, max);
}

function nonNegInt(n) {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function hasForbiddenKey(obj) {
  return Object.keys(obj).some((k) => FORBIDDEN_KEYS.has(k));
}

/**
 * Validate + sanitize one incoming record.
 * @returns {{ok: true, record: object} | {ok: false, reason: string}}
 */
function sanitizeRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not-an-object' };
  }
  if (hasForbiddenKey(raw)) return { ok: false, reason: 'forbidden-key-present' };

  const modulesRaw = Array.isArray(raw.modules) ? raw.modules : [];
  if (modulesRaw.length > MAX_MODULES_PER_RECORD) return { ok: false, reason: 'too-many-modules' };

  const modules = [];
  for (const m of modulesRaw) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
    if (hasForbiddenKey(m)) return { ok: false, reason: 'forbidden-key-in-module' };
    const name = clampStr(m.name, MAX_MODULE_LEN);
    if (!name) continue;
    const status = m.status === 'failed' || m.status === 'skipped' ? m.status : 'ok';
    modules.push({
      name,
      errors: nonNegInt(m.errors),
      warnings: nonNegInt(m.warnings),
      soft: nonNegInt(m.soft),
      status,
    });
  }

  const rulesRaw = Array.isArray(raw.rules) ? raw.rules : [];
  if (rulesRaw.length > MAX_RULES_PER_RECORD) return { ok: false, reason: 'too-many-rules' };
  const rules = [];
  for (const r of rulesRaw) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    if (hasForbiddenKey(r)) return { ok: false, reason: 'forbidden-key-in-rule' };
    const id = typeof r.id === 'string' && r.id.length <= MAX_RULE_LEN && RULE_ID_RE.test(r.id) ? r.id : null;
    if (!id) return { ok: false, reason: 'rule-id-not-an-identifier' };
    rules.push({ id, fired: nonNegInt(r.fired), silenced: nonNegInt(r.silenced) });
  }
  return {
    ok: true,
    record: {
      source: clampStr(raw.source, MAX_SOURCE_LEN) || 'unknown',
      suite: clampStr(raw.suite, MAX_SUITE_LEN) || 'unknown',
      // PASSED / BLOCKED / REPORT_ONLY (engine src/core/report-schema.js); anything else is BLOCKED.
      gateStatus: raw.gateStatus === 'PASSED' || raw.gateStatus === 'REPORT_ONLY' ? raw.gateStatus : 'BLOCKED',
      durationMs: nonNegInt(raw.durationMs),
      moduleCount: modules.length,
      totalErrors: nonNegInt(raw.totalErrors),
      totalWarnings: nonNegInt(raw.totalWarnings),
      modules,
      rules,
    },
  };
}

module.exports = { sanitizeRecord };
