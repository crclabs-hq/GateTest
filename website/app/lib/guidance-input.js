'use strict';
/**
 * Input bounds for POST /api/scan/guidance.
 *
 * The route is public on purpose (the hosted MCP core proxies explain_finding
 * to it with no caller key — see the comment above its handler) and asks the
 * AI model, on OUR key, about every issue no built-in pattern matches. Its
 * spend controls were a per-IP rate limit and the daily server-key ceiling
 * (GATETEST_DAILY_API_BUDGET_USD, Usage Doctrine Meter 3) — but nothing
 * bounded the SIZE of a request: twenty issues with a megabyte of `detail`
 * each were twenty very large prompts, all started before the ceiling could
 * see any of them, and a non-string `detail` crashed the handler with a 500.
 *
 * cleanGuidanceIssues() is applied before anything else touches the body:
 * only objects with a non-empty string `detail`, at most MAX_ISSUES of them,
 * each field cut to a length a human-written finding never exceeds. At most
 * MAX_AI_ISSUES of those reach the model.
 */

const MAX_ISSUES = 50;
const MAX_AI_ISSUES = 20;
const MAX_MODULE_CHARS = 100;
const MAX_DETAIL_CHARS = 2000;

/**
 * @param {unknown} raw  body.issues as received
 * @returns {Array<{ module: string, detail: string }>}
 */
function cleanGuidanceIssues(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= MAX_ISSUES) break;
    if (!item || typeof item !== 'object') continue;
    const detail = typeof item.detail === 'string' ? item.detail.trim() : '';
    if (!detail) continue;
    const moduleName = typeof item.module === 'string' ? item.module.trim() : '';
    out.push({
      module: moduleName.slice(0, MAX_MODULE_CHARS) || 'unknown',
      detail: detail.slice(0, MAX_DETAIL_CHARS),
    });
  }
  return out;
}

module.exports = { MAX_ISSUES, MAX_AI_ISSUES, MAX_MODULE_CHARS, MAX_DETAIL_CHARS, cleanGuidanceIssues };
