/**
 * /admin/secrets — pure logic for the audit drawer: the hash-chain line and
 * IP shortening. (How a row's outcome is inked stays in ./logic.js beside
 * livenessMark, which it reuses.)
 *
 * Split from ./logic.js (same rules: plain CommonJS so node:test can require
 * it, marks name a SHAPE and an INK, never a hue, and nothing here ever sees
 * a secret value — audit rows never hold one).
 */

/**
 * The audit drawer's chain line. Intact ONLY when the server said so
 * explicitly; a missing or malformed `chain` is "cannot tell", never intact.
 * `brokenAt` is the 0-based index of the first bad row, oldest first.
 *
 * @param {{ ok?: unknown, count?: unknown, brokenAt?: unknown } | null | undefined} chain
 * @returns {{ state: 'intact' | 'broken' | 'unknown', shape: 'dot' | 'ring', ink: 'accent' | 'ink' | 'muted', strong: boolean, text: string }}
 */
function chainStatus(chain) {
  if (chain && typeof chain === 'object' && chain.ok === true) {
    const n = Number.isInteger(chain.count) ? chain.count : null;
    const text = n === null ? 'Chain intact' : `Chain intact across all ${n} entr${n === 1 ? 'y' : 'ies'}`;
    return { state: 'intact', shape: 'dot', ink: 'accent', strong: false, text };
  }
  if (chain && typeof chain === 'object' && chain.ok === false) {
    const at = Number.isInteger(chain.brokenAt) && chain.brokenAt >= 0 ? chain.brokenAt + 1 : null;
    const text = at === null ? 'Chain broken (the server did not say where)' : `Chain broken at entry ${at}, counting from the oldest`;
    return { state: 'broken', shape: 'dot', ink: 'ink', strong: true, text };
  }
  return { state: 'unknown', shape: 'ring', ink: 'muted', strong: false, text: 'Chain: cannot tell (the server did not report it)' };
}

/**
 * Shorten a long string (an IPv6 address, a forwarded-for chain) by cutting
 * the MIDDLE, so both the network prefix and the host end stay readable.
 *
 * @param {string | null | undefined} s
 * @param {number} [max]  longest result, ellipsis included (default 20, at least 5)
 */
function middleTruncate(s, max) {
  if (typeof s !== 'string') return '';
  const limit = Math.max(5, Math.floor(max === undefined ? 20 : max));
  if (s.length <= limit) return s;
  const keep = limit - 1;
  return `${s.slice(0, Math.ceil(keep / 2))}…${s.slice(s.length - Math.floor(keep / 2))}`;
}

module.exports = {
  chainStatus,
  middleTruncate,
};
