'use strict';

/**
 * Re-export shim — the canonical live-scan config lives at
 * src/core/live-scan-config.js (moved there in #802 so the CLI's `--crawl`
 * wires modules to a live page through the same code the hosted /web scan
 * does). Forking it back into website/ would reintroduce the two-copies drift
 * issue #681 item 1 fixed. Same shim pattern as website/app/lib/auto-distill.js.
 */

module.exports = require('../../../src/core/live-scan-config.js');
