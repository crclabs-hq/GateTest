'use strict';
/**
 * The human reason carried by a server-sent `error` event.
 *
 * The scan streams send `event: error` with `{ error }` (playground, /web,
 * /wp) but other routes use `{ message }` or `{ error: { message } }`, and a
 * proxy can hand back a bare string. Before this helper the pages read only
 * `.error` and fell back to "Scan errored mid-stream", hiding the real reason
 * ("repository not found or private") from the visitor.
 *
 * Returns plain text only — callers render it as a React text node (escaped),
 * and control characters are stripped and the length capped here so a hostile
 * or runaway payload cannot flood the UI. The string is data, not markup.
 */

const FALLBACK = 'Scan errored mid-stream';
const MAX_LEN = 300;

function pick(data) {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return '';
  for (const key of ['error', 'message', 'reason']) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) return v;
    if (v && typeof v === 'object') {
      const nested = pick(v);
      if (nested) return nested;
    }
  }
  return '';
}

/**
 * @param {unknown} data  the parsed `data:` payload of the error event
 * @param {string} [fallback]
 * @returns {string}
 */
function sseErrorReason(data, fallback = FALLBACK) {
  // eslint-disable-next-line no-control-regex
  const text = pick(data).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > MAX_LEN ? `${text.slice(0, MAX_LEN - 1)}…` : text;
}

module.exports = { sseErrorReason, FALLBACK };
