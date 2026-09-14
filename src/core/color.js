'use strict';
/**
 * One decision about whether the terminal gets ANSI colour.
 *
 * The console reporter always emitted colour, so a CI log or a pipe got
 * "Errors:   \x1b[31m3\x1b[0m" and action.yml's `^errors?:[[:space:]]*[0-9]+`
 * grep matched nothing — every action run reported error-count=0 and
 * warning-count=0 (found by the 2026-09-14 marketplace audit). The
 * convention every other CLI follows:
 *
 *   NO_COLOR set (any non-empty value)  -> off      https://no-color.org
 *   FORCE_COLOR set (and not "0")       -> on       (CI that renders ANSI)
 *   otherwise                           -> on only when stdout is a TTY
 *
 * Decided once at load, like chalk; pass env/stream to decide for a test.
 */

const CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
};

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ isTTY?: boolean }} [stream]
 * @returns {boolean}
 */
function colorEnabled(env = process.env, stream = process.stdout) {
  if (typeof env.NO_COLOR === 'string' && env.NO_COLOR !== '') return false;
  if (typeof env.FORCE_COLOR === 'string' && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  return Boolean(stream && stream.isTTY);
}

/**
 * The palette: the escape codes when colour is on, empty strings when it is
 * off — so `${COLORS.red}${n}${COLORS.reset}` needs no branch at the call site.
 * @param {boolean} [enabled]
 * @returns {Record<keyof typeof CODES, string>}
 */
function palette(enabled = colorEnabled()) {
  const out = {};
  for (const key of Object.keys(CODES)) out[key] = enabled ? CODES[key] : '';
  return out;
}

module.exports = { CODES, colorEnabled, palette };
