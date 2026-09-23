'use strict';

/**
 * One shared definition (Doctrine #4) of how a streaming scan route turns
 * the engine's `module:end` onProgress payload into the SSE event it sends
 * the browser.
 *
 * Issue #648 items 1-2 gave `/api/web/scan/stream` this handling; issue #699
 * is `/api/wp/scan/stream` never receiving the same fix — its `module:end`
 * handler read `.errors`/`.warnings` straight off the live payload (always
 * `undefined`) instead of `.toJSON()`, and never looked at each check's own
 * `notChecked` flag, so a WordPress live scan could tick a not-checked
 * module as checked in the stream while the completed card said otherwise.
 * This is the ONE place both routes build that event from — do not fork it
 * again for a third stream route.
 *
 * `payload` is the runner's live TestResult instance, not its toJSON()
 * shape — reading `.errors`/`.warnings` straight off it (the old code) always
 * reads `undefined`, so every module ticks "clean" in the live list no
 * matter what it actually found or whether it ran at all. `.toJSON()` is the
 * one place that has real numbers AND the raw `checks` array with each
 * check's own `notChecked` flag — the exact shape `deriveModuleCoverage()`
 * reads off `summary.results`.
 *
 * @param {{ toJSON?: () => object } | object} payload
 * @returns {{ module: string, status: 'checked', errors?: number, warnings?: number, info?: number, duration?: number }
 *   | { module: string, status: 'not-checked', reason: string, duration?: number }}
 */
function buildModuleEndEvent(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const p = typeof raw.toJSON === 'function' ? raw.toJSON() : raw;
  const moduleName = p.module || p.name || 'unknown';
  const checks = Array.isArray(p.checks) ? p.checks : [];
  const notCheckedCheck = checks.find((c) => c && c.notChecked === true);
  if (notCheckedCheck) {
    return {
      module: moduleName,
      status: 'not-checked',
      // Issue #648 item 2: this reason is the module's OWN `_notChecked()`
      // message (BaseModule) — never web-runtime-gate.js's dispatch-reason
      // vocabulary ("not-configured" etc). Those describe a separate
      // decision (whether the real-browser runtime pass was dispatched to
      // the platform worker), not why THIS module never looked at anything
      // on this scan.
      reason: notCheckedCheck.message || 'not checked',
      duration: p.duration,
    };
  }
  return {
    module: moduleName,
    status: 'checked',
    errors: p.errors,
    warnings: p.warnings,
    info: p.infoFindings,
    duration: p.duration,
  };
}

module.exports = { buildModuleEndEvent };
