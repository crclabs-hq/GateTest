/**
 * Live-Probe Runner — HTTP request engine for pen-test modules.
 *
 * Every live-probe module (liveSqlInjection, liveXss, liveIdor, etc.) sits
 * on top of this runner. It enforces:
 *   - Per-probe timeout (default 10s, max 30s)
 *   - Global rate limit across all probes in a scan (default 10 req/s)
 *   - Per-host rate limit (default 5 req/s — don't take down the target)
 *   - Concurrency cap (default 8 in flight)
 *   - Total-probe-count cap per scan (default 500 — DoS safety)
 *   - Hard wallclock budget (default 5min — Vercel-safe)
 *   - Forbidden-payload filter (never send destructive payloads)
 *
 * Every request goes through `probe(...)`. There is no other path. If the
 * runner aborts the budget, all subsequent probes fail-fast with a budget
 * exhaustion error, the module records partial results, and the report
 * surfaces "scan stopped at limit: <reason>" to the customer.
 *
 * The runner does NOT decide whether a probe is authorized — that's
 * `authorization-gate.js`. The runner trusts that whoever calls `probe()`
 * has already checked the gate.
 *
 * The runner DOES enforce the don't-take-down-the-target rules even if
 * authorization is granted. Customer authorization to TEST is not
 * authorization to CRASH.
 */

'use strict';

const https = require('https');
const http = require('http');

const DEFAULT_OPTS = {
  perRequestTimeoutMs: 10_000,
  maxPerRequestTimeoutMs: 30_000,
  globalRateLimitPerSec: 10,
  perHostRateLimitPerSec: 5,
  maxConcurrency: 8,
  maxRequestsPerScan: 500,
  maxWallclockMs: 5 * 60 * 1000,
  userAgent: 'GateTest-Pentest/1.0 (+https://gatetest.ai/pentest)',
};

// ─── Forbidden payload patterns — these never go out, no matter what. ────

const FORBIDDEN_PATTERNS = [
  // Destructive SQL
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bDELETE\s+FROM\s+\w+\s*(--|$|;)/i, // DELETE FROM x; or DELETE FROM x --
  // Destructive shell
  /\brm\s+-rf?\s+\//,
  /:\(\)\{.*:\|:&.*\};:/, // fork bomb
  // Mass data exfil
  /SELECT\s+\*\s+FROM\s+\w+\s+INTO\s+OUTFILE/i,
  // DoS payload classes — block ONLY long delays so short detection
  // probes (sleep(3), WAITFOR DELAY '0:0:3') still work.
  /\bsleep\s*\(\s*[0-9]{2,}/i, // sleep(>=10s)
  /\bWAITFOR\s+DELAY\s+'[0-9]+:[0-9]+:[1-9][0-9]+/i, // WAITFOR DELAY '0:0:>=10s'
];

function isForbiddenPayload(payload) {
  if (typeof payload !== 'string') return false;
  return FORBIDDEN_PATTERNS.some((re) => re.test(payload));
}

// ─── Runner ──────────────────────────────────────────────────────────────

class LiveProbeRunner {
  constructor(opts = {}) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this.startedAt = Date.now();
    this.totalRequests = 0;
    this.inflight = 0;
    this.lastReqByHost = new Map();
    this.lastReqGlobal = 0;
    this.aborted = false;
    this.abortReason = null;
    this.results = [];
  }

  _abortIfBudgetExhausted() {
    if (this.aborted) return;
    if (this.totalRequests >= this.opts.maxRequestsPerScan) {
      this.aborted = true;
      this.abortReason = `max-requests-reached (${this.opts.maxRequestsPerScan})`;
      return;
    }
    if (Date.now() - this.startedAt >= this.opts.maxWallclockMs) {
      this.aborted = true;
      this.abortReason = `wallclock-budget-exhausted (${this.opts.maxWallclockMs}ms)`;
      return;
    }
  }

  async _waitForRateLimit(host) {
    const now = Date.now();
    const globalGap = 1000 / this.opts.globalRateLimitPerSec;
    const hostGap = 1000 / this.opts.perHostRateLimitPerSec;
    const lastHost = this.lastReqByHost.get(host) || 0;

    const waitGlobal = Math.max(0, (this.lastReqGlobal + globalGap) - now);
    const waitHost = Math.max(0, (lastHost + hostGap) - now);
    const wait = Math.max(waitGlobal, waitHost);

    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastReqGlobal = Date.now();
    this.lastReqByHost.set(host, this.lastReqGlobal);
  }

  async _waitForSlot() {
    while (this.inflight >= this.opts.maxConcurrency) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Send one probe. Returns { ok, status, headers, body, timeMs, error? }.
   * Throws ONLY on programmer error (forbidden payload, malformed URL).
   * Network errors / timeouts return ok:false with reason.
   */
  async probe({ method = 'GET', url, headers = {}, body = null, payload = null }) {
    this._abortIfBudgetExhausted();
    if (this.aborted) {
      return { ok: false, aborted: true, reason: this.abortReason };
    }

    // Forbidden-payload safety: refuse to transmit destructive payloads
    // even if the caller asks. This is the last-line backstop — the
    // payload library should never produce these but we never trust input.
    if (payload !== null && isForbiddenPayload(payload)) {
      throw new Error(`Forbidden payload pattern; refused to transmit: ${String(payload).slice(0, 80)}`);
    }
    if (body !== null && isForbiddenPayload(body)) {
      throw new Error(`Forbidden body pattern; refused to transmit`);
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Malformed URL: ${url}`);
    }

    // Block requests to private / loopback / metadata endpoints — never
    // probe internal infra even by accident.
    if (this._isBlockedHost(parsed.hostname)) {
      return { ok: false, blocked: true, reason: `blocked-host: ${parsed.hostname}` };
    }

    await this._waitForRateLimit(parsed.hostname);
    await this._waitForSlot();

    this.inflight += 1;
    this.totalRequests += 1;

    const t0 = Date.now();
    try {
      const result = await this._send(parsed, method, headers, body);
      const timeMs = Date.now() - t0;
      const record = { ok: true, ...result, timeMs, url, method };
      this.results.push(record);
      return record;
    } catch (err) {
      const timeMs = Date.now() - t0;
      const record = {
        ok: false, error: err.message || 'unknown', timeMs, url, method,
      };
      this.results.push(record);
      return record;
    } finally {
      this.inflight -= 1;
    }
  }

  _isBlockedHost(host) {
    if (!host) return true;
    const h = host.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0') return true;
    if (h === '169.254.169.254') return true; // AWS metadata
    if (h === 'metadata.google.internal') return true;
    if (h === '100.100.100.200') return true; // Alibaba metadata
    // RFC1918
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
    // Link-local
    if (/^169\.254\./.test(h)) return true;
    return false;
  }

  _send(parsed, method, customHeaders, body) {
    return new Promise((resolve, reject) => {
      const lib = parsed.protocol === 'https:' ? https : http;
      const headers = {
        'User-Agent': this.opts.userAgent,
        Accept: '*/*',
        ...customHeaders,
      };
      const req = lib.request({
        method,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers,
        timeout: this.opts.perRequestTimeoutMs,
      }, (res) => {
        const chunks = [];
        let totalLen = 0;
        const maxBodyBytes = 256 * 1024; // 256KB body cap per response
        res.on('data', (c) => {
          totalLen += c.length;
          if (totalLen <= maxBodyBytes) chunks.push(c);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
            truncated: totalLen > maxBodyBytes,
          });
        });
      });
      req.on('timeout', () => {
        req.destroy(new Error('request-timeout'));
      });
      req.on('error', reject);
      if (body !== null) req.write(body);
      req.end();
    });
  }

  summary() {
    return {
      totalRequests: this.totalRequests,
      aborted: this.aborted,
      abortReason: this.abortReason,
      durationMs: Date.now() - this.startedAt,
      hostsTouched: Array.from(this.lastReqByHost.keys()),
    };
  }
}

module.exports = {
  LiveProbeRunner,
  isForbiddenPayload,
  FORBIDDEN_PATTERNS,
  DEFAULT_OPTS,
};
