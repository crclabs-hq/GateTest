/**
 * Reliability — scanner adapter.
 *
 * Wraps the URL prober (and, later, a code-target adapter) to expose
 * the `{ scan(args) → { findings, peakMemoryMb } }` interface the
 * reliability runner expects.
 *
 * Routes a manifest to the right backend based on `manifest.target`:
 *
 *   target === "url"   → probeUrl()
 *   target === "code"  → (code adapter — TODO, ships after CWE-bench wiring)
 *
 * Dispatch is the only logic here; the actual probes live in their own
 * modules so each can be tested in isolation.
 */

"use strict";

const { probeUrl } = require("./url-prober.js");

/**
 * Build a scanner adapter wired with the supplied dependencies.
 *
 * @param {object} [deps]
 * @param {function} [deps._fetch]       injectable fetch for URL probe
 * @param {function} [deps._codeScanner] optional adapter for code targets
 * @returns {{ scan: function }}
 */
function createScannerAdapter({ _fetch, _codeScanner } = {}) {
  async function scan({ manifest, target }) {
    if (!target || !target.type) {
      throw new TypeError("scannerAdapter: target.type required");
    }
    if (target.type === "url") {
      const r = await probeUrl({ url: target.url, _fetch });
      return {
        findings: r.findings || [],
        peakMemoryMb: null,
        status: r.status,
        error: r.error || null,
        durationMs: r.durationMs,
      };
    }
    if (target.type === "code") {
      if (!_codeScanner || typeof _codeScanner.scan !== "function") {
        return {
          findings: [],
          peakMemoryMb: null,
          error: "no-code-scanner-adapter",
          durationMs: 0,
        };
      }
      return _codeScanner.scan({ manifest, target });
    }
    throw new TypeError(`scannerAdapter: unsupported target.type "${target.type}"`);
  }
  return { scan };
}

module.exports = {
  createScannerAdapter,
};
