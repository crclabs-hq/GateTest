/**
 * GateTest Cache Manager — detects, analyses, and flushes caches.
 * Supports: Vercel Edge Cache, Cloudflare, generic CDN purge webhooks.
 * Falls back to manual instructions when no API token is available.
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');

class CacheManager {
  constructor(options = {}) {
    this.vercelToken    = options.vercelToken    || process.env.VERCEL_TOKEN           || null;
    this.cfZoneId       = options.cfZoneId       || process.env.CF_ZONE_ID             || null;
    this.cfToken        = options.cfToken        || process.env.CF_API_TOKEN           || null;
    this.purgeWebhook   = options.purgeWebhook   || process.env.GATETEST_PURGE_WEBHOOK || null;
  }

  async flush(rawUrl) {
    const url = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
    const report = { url, timestamp: new Date().toISOString(), actions: [], manualSteps: [] };

    await Promise.allSettled([
      this._flushVercel(url, report),
      this._flushCloudflare(url, report),
      this._flushWebhook(url, report),
    ]);

    const anySucceeded = report.actions.some(a => a.success);

    if (!anySucceeded) {
      report.manualSteps.push(...this._manualInstructions(url));
    }

    return report;
  }

  async analyze(rawUrl) {
    const url = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
    const analysis = { url, caches: [] };

    try {
      const { headers } = await this._head(url);

      // Vercel
      const vercelCache = headers['x-vercel-cache'];
      if (vercelCache) analysis.caches.push({ provider: 'Vercel', status: vercelCache, edge: headers['x-vercel-id'] || null });

      // Cloudflare
      const cfCache = headers['cf-cache-status'];
      if (cfCache) analysis.caches.push({ provider: 'Cloudflare', status: cfCache, ray: headers['cf-ray'] || null });

      // Generic CDN
      const xCache = headers['x-cache'];
      if (xCache && !vercelCache && !cfCache) analysis.caches.push({ provider: 'CDN', status: xCache });

      // Cache-Control parsing
      const cc = headers['cache-control'] || '';
      const maxAgeMatch = cc.match(/max-age=(\d+)/);
      const sMaxAgeMatch = cc.match(/s-maxage=(\d+)/);
      analysis.cacheControl = {
        raw: cc,
        maxAge:  maxAgeMatch  ? parseInt(maxAgeMatch[1])  : null,
        sMaxAge: sMaxAgeMatch ? parseInt(sMaxAgeMatch[1]) : null,
        noStore: cc.includes('no-store'),
        noCache: cc.includes('no-cache'),
        strategy: this._classifyStrategy(cc, headers),
      };
      analysis.age = parseInt(headers['age'] || '0');
      analysis.etag = headers['etag'] || null;
      analysis.lastModified = headers['last-modified'] || null;
    } catch (err) {
      analysis.error = err.message;
    }

    return analysis;
  }

  async _flushVercel(url, report) {
    if (!this.vercelToken) return;
    const parsed = new URL(url);
    try {
      const res = await this._apiRequest(
        'api.vercel.com', '/v1/purge-cache',
        { method: 'POST', token: this.vercelToken,
          body: JSON.stringify({ urls: [url], domain: parsed.hostname }) }
      );
      if (res.statusCode < 300) {
        report.actions.push({ provider: 'Vercel', success: true, message: `Purged ${url} from Vercel Edge Cache` });
      } else {
        report.actions.push({ provider: 'Vercel', success: false, message: `Vercel purge HTTP ${res.statusCode}` });
      }
    } catch (err) {
      report.actions.push({ provider: 'Vercel', success: false, message: `Vercel purge failed: ${err.message}` });
    }
  }

  async _flushCloudflare(url, report) {
    if (!this.cfZoneId || !this.cfToken) return;
    try {
      const res = await this._apiRequest(
        'api.cloudflare.com', `/client/v4/zones/${this.cfZoneId}/purge_cache`,
        { method: 'POST', token: this.cfToken, body: JSON.stringify({ files: [url] }) }
      );
      const data = JSON.parse(res.body || '{}');
      if (data.success) {
        report.actions.push({ provider: 'Cloudflare', success: true, message: `Purged ${url} from Cloudflare cache` });
      } else {
        const msg = (data.errors || []).map(e => e.message).join(', ');
        report.actions.push({ provider: 'Cloudflare', success: false, message: `Cloudflare purge failed: ${msg}` });
      }
    } catch (err) {
      report.actions.push({ provider: 'Cloudflare', success: false, message: `Cloudflare purge failed: ${err.message}` });
    }
  }

  async _flushWebhook(url, report) {
    if (!this.purgeWebhook) return;
    try {
      const body = JSON.stringify({ url, action: 'purge', timestamp: new Date().toISOString() });
      const webhookUrl = new URL(this.purgeWebhook);
      const res = await this._apiRequest(webhookUrl.hostname, webhookUrl.pathname,
        { method: 'POST', body, host: webhookUrl.hostname, port: webhookUrl.port });
      if (res.statusCode < 300) {
        report.actions.push({ provider: 'Webhook', success: true, message: `Cache purge webhook delivered` });
      } else {
        report.actions.push({ provider: 'Webhook', success: false, message: `Webhook HTTP ${res.statusCode}` });
      }
    } catch (err) {
      report.actions.push({ provider: 'Webhook', success: false, message: `Webhook failed: ${err.message}` });
    }
  }

  _manualInstructions(url) {
    return [
      `No cache API credentials found. Manual flush options:`,
      `  Vercel:     Set VERCEL_TOKEN env var, then re-run gatetest flush ${url}`,
      `              Or: go to vercel.com → project → Deployments → Redeploy`,
      `  Cloudflare: Set CF_ZONE_ID + CF_API_TOKEN env vars, then re-run`,
      `              Or: go to Cloudflare dashboard → Caching → Purge Everything`,
      `  Any server: curl -X PURGE ${url}  (if nginx purge module installed)`,
      `  Vercel CLI: vercel --prod --force  (triggers fresh deploy + cache bust)`,
    ];
  }

  _classifyStrategy(cc, headers) {
    if (cc.includes('no-store')) return 'bypass';
    if (cc.includes('no-cache') || cc.includes('max-age=0')) return 'revalidate';
    if (cc.includes('s-maxage') || headers['x-vercel-cache'] || headers['cf-cache-status']) return 'cdn-cached';
    if (cc.includes('max-age')) return 'browser-cached';
    return 'unspecified';
  }

  _head(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const req = client.request(url, { method: 'HEAD', timeout: 10000,
        headers: { 'User-Agent': 'GateTest/2.0 CacheManager' } }, (res) => {
        res.resume();
        resolve({ statusCode: res.statusCode, headers: res.headers });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
  }

  _apiRequest(hostname, path, opts = {}) {
    return new Promise((resolve, reject) => {
      const body = opts.body || '';
      const req = https.request({
        hostname, path, method: opts.method || 'POST', port: opts.port || 443,
        headers: {
          'Authorization': opts.token ? `Bearer ${opts.token}` : undefined,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('API timeout')); });
      req.write(body);
      req.end();
    });
  }
}

module.exports = CacheManager;
