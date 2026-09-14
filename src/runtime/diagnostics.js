/**
 * GateTest Diagnostics — full real-time diagnosis of a live URL.
 * Covers: availability, response time, content freshness, cache analysis,
 * bottleneck classification, and recommended actions.
 * Zero external dependencies — Node.js built-ins only.
 */

const https = require('https');
const http  = require('http');
const crypto = require('crypto');
const fs    = require('fs');
const path  = require('path');
const { URL } = require('url');

const STATE_DIR = path.join(process.cwd(), '.gatetest', 'monitor');

class Diagnostics {
  constructor(options = {}) {
    this.timeout   = options.timeout || 15000;
    this.samples   = options.samples || 3;
    this.stateDir  = options.stateDir || STATE_DIR;
  }

  async diagnose(rawUrl) {
    const url = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
    const parsed = new URL(url);

    const result = {
      url,
      hostname: parsed.hostname,
      timestamp: new Date().toISOString(),
      status: 'healthy',
      issues: [],
      actions: [],
      checks: {},
    };

    await Promise.all([
      this._checkAvailability(url, result),
      this._checkResponseTime(url, result),
      this._checkContentFreshness(url, result),
      this._checkCacheHeaders(url, result),
    ]);

    this._classifyBottleneck(result);
    this._buildActionPlan(result);

    if (result.issues.some(i => i.severity === 'critical')) result.status = 'critical';
    else if (result.issues.some(i => i.severity === 'error'))  result.status = 'degraded';
    else if (result.issues.some(i => i.severity === 'warning')) result.status = 'warning';

    return result;
  }

  async _checkAvailability(url, result) {
    const paths = ['', '/health', '/api/health', '/healthz', '/ping', '/status'];
    const found = [];

    for (const p of paths) {
      try {
        const testUrl = url.replace(/\/$/, '') + p;
        const { statusCode, ms } = await this._request(testUrl, 'HEAD');
        if (statusCode >= 200 && statusCode < 400) {
          found.push({ path: p || '/', status: statusCode, ms });
        }
      } catch { /* error-ok — path not available */ }
    }

    result.checks.availability = { found };

    if (found.length === 0) {
      result.issues.push({ severity: 'critical', code: 'site-down', message: 'No endpoint responds — site appears to be down' });
    } else {
      result.checks.availability.primary = found[0];
    }
  }

  async _checkResponseTime(url, result) {
    const times = [];
    for (let i = 0; i < this.samples; i++) {
      try {
        const { ms } = await this._request(url, 'GET');
        times.push(ms);
      } catch { times.push(null); }
    }

    const valid = times.filter(t => t !== null);
    if (valid.length === 0) {
      result.issues.push({ severity: 'critical', code: 'unreachable', message: 'All requests timed out or failed' });
      return;
    }

    valid.sort((a, b) => a - b);
    const p50 = valid[Math.floor(valid.length * 0.5)];
    const p95 = valid[Math.floor(valid.length * 0.95)] ?? valid[valid.length - 1];
    result.checks.responseTime = { p50, p95, samples: valid };

    if (p50 > 3000) result.issues.push({ severity: 'critical', code: 'very-slow', message: `p50 response time ${p50}ms — server critically slow` });
    else if (p50 > 1500) result.issues.push({ severity: 'error', code: 'slow', message: `p50 response time ${p50}ms — server slow` });
    else if (p50 > 800)  result.issues.push({ severity: 'warning', code: 'degraded', message: `p50 response time ${p50}ms — above 800ms threshold` });
  }

  async _checkContentFreshness(url, result) {
    try {
      const { statusCode, headers, body } = await this._request(url, 'GET', true);
      if (statusCode < 200 || statusCode >= 300) return;

      const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
      const lastModified = headers['last-modified'];
      const etag = headers['etag'];
      const age = parseInt(headers['age'] || '0');
      const staleAt = parseInt((headers['cache-control'] || '').match(/max-age=(\d+)/)?.[1] || '0');

      result.checks.freshness = { hash, lastModified, etag, age, staleAt };

      // Compare against stored state
      const stateFile = this._stateFile(url);
      if (fs.existsSync(stateFile)) {
        const prev = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        const staleSince = prev.hash === hash ? Date.now() - prev.firstSeenMs : 0;

        if (staleSince > 0) {
          result.checks.freshness.staleSinceMs = staleSince;
          result.checks.freshness.staleSinceMin = Math.round(staleSince / 60000);
        }

        if (staleSince > 30 * 60 * 1000 && staleAt > 0 && age > staleAt) {
          result.issues.push({ severity: 'error', code: 'content-stale', message: `Content unchanged for ${Math.round(staleSince / 60000)} min but cache TTL exceeded — likely a cache flush issue` });
        }
      }

      // Save state
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const existing = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
      fs.writeFileSync(stateFile, JSON.stringify({
        hash,
        firstSeenMs: existing.hash === hash ? (existing.firstSeenMs || Date.now()) : Date.now(),
        lastCheckedMs: Date.now(),
      }));
    } catch { /* error-ok — state persistence is best-effort; the diagnostic result is already in `result` */ }
  }

  async _checkCacheHeaders(url, result) {
    try {
      const { headers } = await this._request(url, 'HEAD');

      const cc = headers['cache-control'] || '';
      const age = headers['age'];
      const etag = headers['etag'];
      const lastMod = headers['last-modified'];
      const cfCache = headers['cf-cache-status'];
      const xCache = headers['x-cache'] || headers['x-vercel-cache'];

      result.checks.cache = { cacheControl: cc, age, etag, lastMod, cdnStatus: cfCache || xCache };

      if (!cc) result.issues.push({ severity: 'warning', code: 'no-cache-control', message: 'No Cache-Control header — browser and CDN behaviour undefined' });
      if (cc.includes('no-store') || cc.includes('no-cache')) {
        result.checks.cache.strategy = 'bypass';
      } else if (cc.includes('max-age=0') || cc.includes('must-revalidate')) {
        result.checks.cache.strategy = 'revalidate';
      } else {
        result.checks.cache.strategy = 'cached';
      }

      if (cfCache === 'MISS' || xCache === 'Miss') {
        result.issues.push({ severity: 'info', code: 'cache-miss', message: 'CDN cache miss — origin took the hit for this request' });
      }
      if (cfCache === 'EXPIRED') {
        result.issues.push({ severity: 'warning', code: 'cache-expired', message: 'CDN cache expired — content may be stale, flush recommended' });
      }
    } catch { /* error-ok — the cache-header probe is best-effort; its absence is not a finding */ }
  }

  _classifyBottleneck(result) {
    const rt = result.checks.responseTime;
    if (!rt) return;

    const { p50, p95 } = rt;
    const spread = p95 - p50;
    let bottleneck = 'none';

    if (p50 > 800 && spread < 300) bottleneck = 'compute';     // consistently slow → CPU or heavy computation
    if (p50 > 800 && spread > 500) bottleneck = 'database';    // variable slow → DB query variance
    if (p50 < 300 && p95 > 2000)  bottleneck = 'concurrency';  // fast median, spiky tail → thread contention
    if (result.checks.cache?.strategy === 'bypass' && p50 > 500) bottleneck = 'cache-disabled';

    result.checks.bottleneck = { classification: bottleneck, p50, p95, spread };
  }

  _buildActionPlan(result) {
    const actions = [];
    for (const issue of result.issues) {
      switch (issue.code) {
        case 'site-down':
          actions.push('Check server process is running (systemctl status / pm2 list)');
          actions.push('Check server logs for crash: journalctl -u your-service -n 100');
          actions.push('Verify port is bound: ss -tlnp | grep <port>');
          break;
        case 'very-slow': case 'slow':
          actions.push('Run: gatetest diagnose <url> --samples 10  to confirm trend');
          actions.push('Check server CPU/memory: top -bn1 | head -20');
          actions.push('Check for N+1 queries: gatetest --module nPlusOne');
          break;
        case 'content-stale':
          actions.push('Run: gatetest flush <url>  to purge CDN + origin cache');
          actions.push('Check deployment completed: verify latest git HEAD is deployed');
          break;
        case 'cache-expired':
          actions.push('Run: gatetest flush <url>  to force CDN re-fetch from origin');
          break;
        case 'cache-disabled':
          actions.push('Add Cache-Control headers to improve performance');
          actions.push('Run: gatetest --module cacheHeaders  to find missing cache config');
          break;
        case 'no-cache-control':
          actions.push('Add Cache-Control: max-age=3600, stale-while-revalidate=86400 to responses');
          break;
      }
    }
    result.actions = [...new Set(actions)];
  }

  async _request(url, method = 'GET', readBody = false) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const client = url.startsWith('https') ? https : http;
      const req = client.request(url, {
        method,
        timeout: this.timeout,
        headers: { 'User-Agent': 'GateTest/2.0 Diagnostics' },
        followRedirect: true,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          this._request(res.headers.location, method, readBody).then(resolve).catch(reject);
          return;
        }
        const chunks = [];
        res.on('data', c => { if (readBody) chunks.push(c); });
        res.on('end', () => resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          ms: Date.now() - start,
          body: readBody ? Buffer.concat(chunks).toString() : null,
        }));
      });
      req.on('error', reject);
      req.setTimeout(this.timeout, () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
  }

  _stateFile(url) {
    const safe = url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 80);
    return path.join(this.stateDir, `${safe}.json`);
  }
}

module.exports = Diagnostics;
