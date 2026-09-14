/**
 * GateTest Healer — automated remediation playbooks.
 * Given a diagnostic result, applies every safe automatic fix and lists
 * what still needs a human (or Craig's authorization).
 */

const CacheManager = require('./cache-manager');

class Healer {
  constructor(options = {}) {
    this.cache = new CacheManager(options);
    this.deployHook = options.deployHook || process.env.GATETEST_DEPLOY_HOOK || null;
    this.restartHook = options.restartHook || process.env.GATETEST_RESTART_HOOK || null;
    this.dryRun = options.dryRun || false;
  }

  async heal(diagnostic) {
    const report = {
      url: diagnostic.url,
      timestamp: new Date().toISOString(),
      automated: [],
      manual: [],
      escalate: [],
    };

    for (const issue of (diagnostic.issues || [])) {
      await this._dispatch(issue, diagnostic, report);
    }

    if (report.automated.length === 0 && report.manual.length === 0) {
      report.automated.push({ action: 'no-action', message: 'No issues requiring remediation found' });
    }

    return report;
  }

  async _dispatch(issue, diagnostic, report) {
    switch (issue.code) {
      case 'content-stale':
      case 'cache-expired':
        return this._flushCache(diagnostic.url, issue, report);

      case 'site-down':
        return this._handleDown(diagnostic.url, issue, report);

      case 'very-slow':
      case 'slow':
        return this._handleSlow(diagnostic, issue, report);

      case 'cache-disabled':
      case 'no-cache-control':
        return this._handleCacheConfig(issue, report);

      default:
        report.manual.push({ code: issue.code, message: issue.message, steps: diagnostic.actions });
    }
  }

  async _flushCache(url, issue, report) {
    if (this.dryRun) {
      report.automated.push({ action: 'flush-cache', dryRun: true, message: `Would flush cache for ${url}` });
      return;
    }
    const result = await this.cache.flush(url);
    const succeeded = result.actions.filter(a => a.success);
    if (succeeded.length > 0) {
      report.automated.push({
        action: 'flush-cache',
        success: true,
        providers: succeeded.map(a => a.provider),
        message: `Cache flushed via ${succeeded.map(a => a.provider).join(', ')}`,
      });
    } else {
      report.manual.push({ action: 'flush-cache', message: 'Automated flush unavailable — API tokens not set', steps: result.manualSteps });
    }
  }

  async _handleDown(url, issue, report) {
    // Try restart hook first
    if (this.restartHook && !this.dryRun) {
      try {
        const ok = await this._webhook(this.restartHook, { url, action: 'restart', reason: issue.code });
        if (ok) {
          report.automated.push({ action: 'restart', success: true, message: `Restart hook triggered for ${url}` });
          return;
        }
      } catch { /* error-ok — fall through to manual */ }
    }

    // Try deploy hook (redeploy as recovery)
    if (this.deployHook && !this.dryRun) {
      try {
        const ok = await this._webhook(this.deployHook, { url, action: 'redeploy', reason: issue.code });
        if (ok) {
          report.automated.push({ action: 'redeploy', success: true, message: `Redeploy hook triggered for ${url}` });
          return;
        }
      } catch { /* error-ok — fall through to manual */ }
    }

    report.escalate.push({
      severity: 'critical',
      message: 'Site is down — automated recovery unavailable',
      steps: [
        'Set GATETEST_RESTART_HOOK or GATETEST_DEPLOY_HOOK to enable auto-recovery',
        'Check server: ssh <host> && systemctl status <service>',
        'Check logs: journalctl -u <service> -n 100',
        'Check disk space: df -h',
        'Check memory: free -m',
        'Vercel: go to Dashboard → Deployments → Redeploy latest',
      ],
    });
  }

  _handleSlow(diagnostic, issue, report) {
    const bt = diagnostic.checks?.bottleneck?.classification;
    const steps = {
      compute:     ['Profile CPU: add --inspect flag and connect Chrome DevTools', 'Look for synchronous blocking code in hot paths', 'Run: gatetest --module nPlusOne  to find expensive DB queries'],
      database:    ['Check DB connection pool is not exhausted', 'Run: gatetest --module nPlusOne  to find N+1 query patterns', 'Add database indexes for the slowest queries', 'Check DB server disk I/O: iostat -x 1 5'],
      concurrency: ['Increase server concurrency / worker threads', 'Check for lock contention in async code', 'Run: gatetest --module raceCondition  to find TOCTOU patterns'],
      'cache-disabled': ['Enable CDN caching for static assets', 'Add Cache-Control: s-maxage=86400 to API responses where safe'],
    };

    report.manual.push({
      action: 'investigate-slow',
      bottleneck: bt || 'unknown',
      message: `${issue.message} — bottleneck classification: ${bt || 'unknown'}`,
      steps: steps[bt] || ['Add monitoring to identify the slow layer', 'Check server metrics: CPU, memory, disk, network'],
    });
  }

  _handleCacheConfig(issue, report) {
    report.manual.push({
      action: 'fix-cache-config',
      message: issue.message,
      steps: [
        'Run: gatetest --module cacheHeaders  to find all missing cache config',
        'Add to next.config.js headers: Cache-Control: max-age=3600, stale-while-revalidate=86400',
        'Vercel: add cache headers in vercel.json under "headers"',
        'After fixing, re-run: gatetest diagnose <url>  to confirm improvement',
      ],
    });
  }

  async _webhook(url, body) {
    const https = require('https');
    const http  = require('http');
    const payload = JSON.stringify(body);
    return new Promise((resolve) => {
      const client = url.startsWith('https') ? https : http;
      const req = client.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 10000,
      }, (res) => { res.resume(); resolve(res.statusCode < 300); });
      req.on('error', () => resolve(false));
      req.setTimeout(10000, () => { req.destroy(); resolve(false); });
      req.write(payload);
      req.end();
    });
  }
}

module.exports = Healer;
