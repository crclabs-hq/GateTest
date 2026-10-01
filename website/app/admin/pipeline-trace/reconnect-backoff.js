'use strict';

/**
 * Backoff for the live scan feed after a dropped or refused connection:
 * 1s, 2s, 5s, 10s, then 30s for every attempt after that. A graceful server
 * close (the stream route ends every stream at 55s) reconnects on the first
 * step and resets the count. Plain JS so tests/admin-honest-states.test.js
 * can require it directly.
 */
const RECONNECT_STEPS_MS = [1000, 2000, 5000, 10000, 30000];
const RECONNECT_CAP_MS = 30000;

/** @param {number} attempt  0-based count of consecutive failures */
function reconnectDelayMs(attempt) {
  const i = Math.max(0, Math.floor(attempt));
  return Math.min(RECONNECT_STEPS_MS[Math.min(i, RECONNECT_STEPS_MS.length - 1)], RECONNECT_CAP_MS);
}

module.exports = { reconnectDelayMs };
