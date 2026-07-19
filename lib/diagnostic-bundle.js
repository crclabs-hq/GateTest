/**
 * Diagnostic Bundle — Inclusive Agentic QA Platform Phase 3A
 * (docs/ROADMAP.md, "Pre-authorized where it extends existing --auto-pr").
 *
 * Modules that run a real headless browser (runtime-errors.js,
 * console-errors.js, cross-browser.js) already capture rich structured
 * detail on a finding — stack traces, grouped network-failure records,
 * per-engine render diffs — via the `details` field passed to
 * `result.addCheck(name, passed, { details, ... })`. Until now that data
 * reached the module report but was dropped on the floor before the AI
 * fix engine ever saw it: `aiFix()` only received `issueMessage`, a single
 * human sentence. Claude was fixing "Uncaught JS error: Cannot read
 * properties of undefined" blind, without the stack trace that names the
 * actual property and call site.
 *
 * This module compiles whatever diagnostic detail was captured at
 * detection time into a readable Markdown header, prepended to the fix
 * prompt alongside the existing conventions/stack/prior-art headers.
 * `details` shape varies per module by design (a stack-trace string, a
 * network-failure-group object, an array of per-engine error records) —
 * `buildDiagnosticBundle` accepts any of those honestly rather than
 * enforcing a rigid DOM-snapshot/network-log schema no module actually
 * produces today. When a caller has nothing beyond the one-line message
 * (the common case — most modules are static analysis with no `details`
 * payload), the bundle is empty and the header is "" — no fabrication.
 *
 * Pure JS, CommonJS, Node stdlib only. Directly testable under
 * `node --test`. Style matches `lib/contextual-grounding.js`.
 *
 * Three exports:
 *   1. buildDiagnosticBundle     — normalise raw finding data into sections
 *   2. formatDiagnosticHeader    — render the Markdown header block
 *   3. summariseDiagnosticBundle — one-line human-readable summary
 */

'use strict';

const MAX_DETAIL_BYTES = 2000;
const MAX_ERROR_BYTES = 1000;

/**
 * Truncate a string to at most `maxBytes` bytes (UTF-8), breaking on
 * whitespace when possible so we don't cut mid-word.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateToBytes(text, maxBytes) {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return text;

  let sliced = buf.slice(0, maxBytes).toString('utf-8');
  sliced = sliced.replace(/�$/, '');

  const lastWs = sliced.search(/\s\S*$/);
  if (lastWs > 0) {
    sliced = sliced.slice(0, lastWs);
  }

  return `${sliced.trimEnd()}\n…(truncated)`;
}

/**
 * Render arbitrary `details` payload (string, array, or object — the three
 * shapes GateTest's live-browser modules actually emit) into readable text.
 *
 * @param {*} details
 * @returns {string}  — "" when there is nothing renderable
 */
function stringifyDetail(details) {
  if (details === null || details === undefined) return '';
  if (typeof details === 'string') return details.trim();

  if (Array.isArray(details)) {
    if (details.length === 0) return '';
    return details
      .map((entry) => (typeof entry === 'string' ? entry : safeJson(entry)))
      .filter(Boolean)
      .join('\n');
  }

  if (typeof details === 'object') {
    if (Object.keys(details).length === 0) return '';
    return safeJson(details);
  }

  return String(details);
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Compile everything captured about a finding into a structured bundle.
 *
 * @param {Object} opts
 * @param {string} [opts.errorMessage]  — the finding's human-readable message
 * @param {*}      [opts.details]       — raw `check.details` (module-specific shape)
 * @returns {{ sections: Array<{title:string, body:string}>, hasContent: boolean }}
 */
function buildDiagnosticBundle({ errorMessage, details } = {}) {
  const sections = [];

  if (errorMessage && String(errorMessage).trim()) {
    sections.push({
      title: 'Error',
      body: truncateToBytes(String(errorMessage).trim(), MAX_ERROR_BYTES),
    });
  }

  const detailText = stringifyDetail(details);
  if (detailText) {
    sections.push({
      title: 'Captured Detail (from live detection — stack trace / network / render diff)',
      body: truncateToBytes(detailText, MAX_DETAIL_BYTES),
    });
  }

  return { sections, hasContent: sections.length > 0 };
}

/**
 * Render the diagnostic header that gets prepended to the Claude fix
 * prompt, alongside the conventions/stack/prior-art headers.
 *
 * @param {{ sections: Array<{title:string, body:string}>, hasContent: boolean }} bundle
 * @returns {string}  — "" when the bundle is empty
 */
function formatDiagnosticHeader(bundle) {
  if (!bundle || !bundle.hasContent) return '';

  const body = bundle.sections.map((s) => `### ${s.title}\n${s.body}`).join('\n\n');

  return [
    '## Diagnostic Bundle (captured at detection time)',
    '',
    'GateTest captured the following context when this issue was found — use it',
    'to understand the FULL failure, not just the one-line summary below.',
    '',
    body,
    '',
    '---',
    '',
  ].join('\n');
}

/**
 * One-line human-readable summary for logging / PR bodies.
 *
 * @param {{ sections: Array<{title:string}>, hasContent: boolean }} bundle
 * @returns {string}
 */
function summariseDiagnosticBundle(bundle) {
  if (!bundle || !bundle.hasContent) return 'diagnostic bundle: no extra detail captured';
  return `diagnostic bundle: ${bundle.sections.length} section(s) captured`;
}

module.exports = {
  buildDiagnosticBundle,
  formatDiagnosticHeader,
  summariseDiagnosticBundle,
};
