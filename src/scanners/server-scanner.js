/**
 * Server Scanner — live URL scanning for SSL, headers, DNS, and performance.
 *
 * Takes a URL instead of a repo path. Runs against the live server.
 * No dependencies — uses Node.js built-in https, tls, dns.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const dns = require('dns');
const tls = require('tls');
// One definition of directive-aware `unsafe-inline` classification (issue
// #681 item 3), shared with src/modules/web-headers.js's live header check.
const { classifyUnsafeInline } = require('../core/csp-analyzer');

// One definition of what the compression probe advertises. Without an
// Accept-Encoding header a well-behaved server answers `identity` — that is
// the server correctly following the request, not the server failing to
// compress (reproduced against tallrig.com/gluecron.com, which both return
// Content-Encoding: gzip once asked). _timedRequest never reads the response
// body (only status/headers), so requesting a compressed body here is safe
// even though nothing decompresses it.
const COMPRESSION_ACCEPT_ENCODING = 'gzip, br, zstd';

class ServerScanner {
  constructor() {
    this.modules = [
      { name: 'ssl', label: 'SSL / TLS Certificate' },
      { name: 'headers', label: 'Security Headers' },
      { name: 'dns', label: 'DNS & Email Security' },
      { name: 'performance', label: 'Response Performance' },
      { name: 'availability', label: 'Availability & Redirects' },
    ];
  }

  /**
   * Every module's `details` line is prefixed `error:` / `warning:` /
   * `pass:` / `info:` (see the individual `_check*` methods below) — the
   * ONE place that severity actually lives, since `mod.issues` conflates
   * both severities into a single count. bin/gatetest.js's `--server`
   * summary line and exit code (issue #677 item 3: warnings must never fail
   * the gate unless `--strict`) both read this one function so the two can
   * never disagree about how many of each there were.
   */
  static countSeverities(result) {
    let errors = 0;
    let warnings = 0;
    for (const mod of result.modules || []) {
      for (const d of mod.details || []) {
        if (d.startsWith('error:')) errors++;
        else if (d.startsWith('warning:')) warnings++;
      }
    }
    return { errors, warnings };
  }

  /**
   * The `--server` exit code (issue #677 item 3): a warning-only result
   * (e.g. a CSP 'unsafe-inline' warning) must not fail the gate on its own
   * — that contradicts the error/warning/info three-state policy every
   * other severity-aware surface in this repo follows. Only errors block by
   * default; `--strict` also blocks on warnings, the same meaning
   * `--strict` carries on a suite scan.
   */
  static exitCode(result, { strict = false } = {}) {
    const { errors, warnings } = ServerScanner.countSeverities(result);
    return errors > 0 || (strict === true && warnings > 0) ? 1 : 0;
  }

  /** The one-line severity summary — "CLEAN" or "N warning(s), N error(s)". */
  static summaryLabel(result) {
    const { errors, warnings } = ServerScanner.countSeverities(result);
    if (errors === 0 && warnings === 0) return 'CLEAN';
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    return `${plural(warnings, 'warning')}, ${plural(errors, 'error')}`;
  }

  async scan(url) {
    const parsed = new URL(url);
    const results = {
      url,
      hostname: parsed.hostname,
      timestamp: new Date().toISOString(),
      modules: [],
      totalIssues: 0,
      totalChecks: 0,
      duration: 0,
    };

    const start = Date.now();

    const moduleResults = await Promise.allSettled([
      this._checkSSL(parsed),
      this._checkHeaders(url),
      this._checkDNS(parsed.hostname),
      this._checkPerformance(url),
      this._checkAvailability(url),
    ]);

    const moduleNames = ['ssl', 'headers', 'dns', 'performance', 'availability'];
    const moduleLabels = ['SSL / TLS', 'Security Headers', 'DNS', 'Performance', 'Availability'];

    for (let i = 0; i < moduleResults.length; i++) {
      const settled = moduleResults[i];
      if (settled.status === 'fulfilled') {
        const mod = settled.value;
        mod.name = moduleNames[i];
        mod.label = moduleLabels[i];
        results.modules.push(mod);
        results.totalIssues += mod.issues;
        results.totalChecks += mod.checks;
      } else {
        results.modules.push({
          name: moduleNames[i],
          label: moduleLabels[i],
          status: 'failed',
          checks: 0,
          issues: 1,
          details: [`Error: ${settled.reason?.message || 'Unknown error'}`],
        });
        results.totalIssues++;
      }
    }

    results.duration = Date.now() - start;
    return results;
  }

  async _checkSSL(parsed) {
    const mod = { status: 'passed', checks: 0, issues: 0, details: [] };

    if (parsed.protocol !== 'https:') {
      mod.status = 'failed';
      mod.issues++;
      mod.checks++;
      mod.details.push('error: Site not using HTTPS');
      return mod;
    }

    return new Promise((resolve) => {
      const socket = tls.connect({
        host: parsed.hostname,
        port: parsed.port || 443,
        servername: parsed.hostname,
        timeout: 10000,
      }, () => {
        const cert = socket.getPeerCertificate();

        // Check certificate exists
        mod.checks++;
        if (!cert || !cert.subject) {
          mod.issues++;
          mod.details.push('error: No SSL certificate found');
          mod.status = 'failed';
          socket.end();
          resolve(mod);
          return;
        }

        // Check expiry
        mod.checks++;
        const expiry = new Date(cert.valid_to);
        const daysLeft = Math.floor((expiry - Date.now()) / (1000 * 60 * 60 * 24));
        if (daysLeft < 0) {
          mod.issues++;
          mod.details.push(`error: SSL certificate EXPIRED ${Math.abs(daysLeft)} days ago`);
          mod.status = 'failed';
        } else if (daysLeft < 14) {
          mod.issues++;
          mod.details.push(`warning: SSL certificate expires in ${daysLeft} days`);
          if (mod.status !== 'failed') mod.status = 'warning';
        } else if (daysLeft < 30) {
          mod.details.push(`info: SSL certificate expires in ${daysLeft} days`);
        } else {
          mod.details.push(`pass: SSL certificate valid for ${daysLeft} days`);
        }

        // Check protocol version
        mod.checks++;
        const protocol = socket.getProtocol();
        if (protocol === 'TLSv1' || protocol === 'TLSv1.1') {
          mod.issues++;
          mod.details.push(`error: Using deprecated ${protocol} — upgrade to TLSv1.2+`);
          mod.status = 'failed';
        } else {
          mod.details.push(`pass: Using ${protocol}`);
        }

        // Check subject matches hostname
        mod.checks++;
        const cn = cert.subject?.CN || '';
        const altNames = (cert.subjectaltname || '').split(',').map(s => s.trim().replace('DNS:', ''));
        const allNames = [cn, ...altNames];
        const matches = allNames.some(name => {
          if (name.startsWith('*.')) {
            return parsed.hostname.endsWith(name.slice(1)) || parsed.hostname === name.slice(2);
          }
          return name === parsed.hostname;
        });
        if (!matches) {
          mod.issues++;
          mod.details.push(`warning: Certificate CN/SAN doesn't match hostname ${parsed.hostname}`);
          if (mod.status !== 'failed') mod.status = 'warning';
        }

        // Check issuer
        mod.checks++;
        const issuer = cert.issuer?.O || cert.issuer?.CN || 'Unknown';
        mod.details.push(`info: Issued by ${issuer}`);

        socket.end();
        resolve(mod);
      });

      socket.on('error', (err) => {
        mod.checks++;
        mod.issues++;
        mod.details.push(`error: SSL connection failed — ${err.message}`);
        mod.status = 'failed';
        resolve(mod);
      });

      socket.setTimeout(10000, () => {
        mod.checks++;
        mod.issues++;
        mod.details.push('error: SSL connection timed out');
        mod.status = 'failed';
        socket.destroy();
        resolve(mod);
      });
    });
  }

  async _checkHeaders(url) {
    const mod = { status: 'passed', checks: 0, issues: 0, details: [] };

    const headers = await this._fetchHeaders(url);
    if (!headers) {
      mod.issues++;
      mod.checks++;
      mod.details.push('error: Could not fetch headers');
      mod.status = 'failed';
      return mod;
    }

    const required = [
      { name: 'strict-transport-security', label: 'HSTS', severity: 'error' },
      { name: 'x-content-type-options', label: 'X-Content-Type-Options', severity: 'warning' },
      { name: 'x-frame-options', label: 'X-Frame-Options', severity: 'warning' },
      { name: 'content-security-policy', label: 'Content-Security-Policy', severity: 'warning' },
      { name: 'referrer-policy', label: 'Referrer-Policy', severity: 'info' },
      { name: 'permissions-policy', label: 'Permissions-Policy', severity: 'info' },
    ];

    for (const { name, label, severity } of required) {
      mod.checks++;
      const value = headers[name];
      if (!value) {
        if (severity === 'error' || severity === 'warning') mod.issues++;
        mod.details.push(`${severity}: Missing ${label} header`);
        if (severity === 'error') mod.status = 'failed';
        else if (severity === 'warning' && mod.status !== 'failed') mod.status = 'warning';
      } else {
        mod.details.push(`pass: ${label} present`);
      }
    }

    // Check HSTS max-age
    mod.checks++;
    const hsts = headers['strict-transport-security'];
    if (hsts) {
      const maxAgeMatch = hsts.match(/max-age=(\d+)/);
      const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1]) : 0;
      if (maxAge < 15552000) { // 180 days
        mod.issues++;
        mod.details.push(`warning: HSTS max-age is ${maxAge}s (recommend >= 15552000 / 180 days)`);
      }
      if (!hsts.includes('includeSubDomains')) {
        mod.details.push('info: HSTS missing includeSubDomains directive');
      }
    }

    // Check CSP unsafe directives
    mod.checks++;
    const csp = headers['content-security-policy'];
    if (csp) {
      // Directive-aware (issue #681 item 3): 'unsafe-inline' in script-src
      // (or default-src when script-src is absent) is XSS-relevant and
      // stays a warning; 'unsafe-inline' ONLY in style-src cannot execute
      // script, so it drops to an info note naming the directive instead
      // of the same warning a real inline-script hole gets.
      const unsafeInline = classifyUnsafeInline(csp);
      if (unsafeInline) {
        if (unsafeInline.severity === 'warning') {
          mod.issues++;
          mod.details.push(`warning: CSP contains 'unsafe-inline' in ${unsafeInline.directive}`);
        } else {
          mod.details.push(`info: CSP contains 'unsafe-inline' in ${unsafeInline.directive} only — inline styles, not inline scripts, so this is lower risk`);
        }
      }
      if (csp.includes("'unsafe-eval'")) {
        mod.issues++;
        mod.details.push("error: CSP contains 'unsafe-eval'");
        mod.status = 'failed';
      }
    }

    // Check server header leaking version info
    mod.checks++;
    const server = headers['server'];
    if (server && /\d+\.\d+/.test(server)) {
      mod.issues++;
      mod.details.push(`warning: Server header leaks version info: ${server}`);
    }

    // Check X-Powered-By
    mod.checks++;
    if (headers['x-powered-by']) {
      mod.issues++;
      mod.details.push(`warning: X-Powered-By header exposes technology: ${headers['x-powered-by']}`);
    }

    return mod;
  }

  async _checkDNS(hostname) {
    const mod = { status: 'passed', checks: 0, issues: 0, details: [] };

    // Check A/AAAA records (with OS resolver fallback)
    mod.checks++;
    try {
      const addresses = await new Promise((resolve, reject) => {
        dns.resolve4(hostname, (err, addrs) => err ? reject(err) : resolve(addrs));
      });
      mod.details.push(`pass: ${addresses.length} A record(s) → ${addresses.join(', ')}`);
    } catch {
      // Fallback to OS resolver (follows CNAMEs, matches nslookup behaviour)
      try {
        const lookup = await new Promise((resolve, reject) => {
          dns.lookup(hostname, { family: 4 }, (err, addr) => err ? reject(err) : resolve(addr));
        });
        mod.details.push(`pass: Resolves to ${lookup} (via CNAME chain)`);
      } catch {
        mod.issues++;
        mod.details.push('error: Hostname does not resolve');
      }
    }

    // Check AAAA (IPv6)
    mod.checks++;
    try {
      await new Promise((resolve, reject) => {
        dns.resolve6(hostname, (err, addrs) => err ? reject(err) : resolve(addrs));
      });
      mod.details.push('pass: IPv6 (AAAA) record found');
    } catch {
      mod.details.push('info: No IPv6 (AAAA) record');
    }

    // Check MX records
    mod.checks++;
    try {
      const mx = await new Promise((resolve, reject) => {
        dns.resolveMx(hostname, (err, addrs) => err ? reject(err) : resolve(addrs));
      });
      mod.details.push(`pass: ${mx.length} MX record(s) found`);
    } catch {
      mod.details.push('info: No MX records (not an email domain)');
    }

    // Check TXT for SPF
    mod.checks++;
    try {
      const txt = await new Promise((resolve, reject) => {
        dns.resolveTxt(hostname, (err, records) => err ? reject(err) : resolve(records));
      });
      const flat = txt.map(r => r.join('')).join('\n');
      if (flat.includes('v=spf1')) {
        mod.details.push('pass: SPF record found');
      } else {
        mod.issues++;
        mod.details.push('warning: No SPF record — email spoofing risk');
      }
      if (flat.includes('v=DMARC1') || flat.includes('_dmarc')) {
        mod.details.push('pass: DMARC reference found');
      }
    } catch {
      mod.details.push('info: No TXT records');
    }

    // Check DMARC specifically
    mod.checks++;
    try {
      await new Promise((resolve, reject) => {
        dns.resolveTxt(`_dmarc.${hostname}`, (err, records) => err ? reject(err) : resolve(records));
      });
      mod.details.push('pass: DMARC record found');
    } catch {
      mod.issues++;
      mod.details.push('warning: No DMARC record — email authentication not configured');
    }

    return mod;
  }

  async _checkPerformance(url) {
    const mod = { status: 'passed', checks: 0, issues: 0, details: [] };

    // Time to first byte (TTFB)
    mod.checks++;
    const start = Date.now();
    try {
      const { statusCode, headers } = await this._timedRequest(url);
      const ttfb = Date.now() - start;

      mod.details.push(`info: TTFB: ${ttfb}ms`);
      if (ttfb > 2000) {
        mod.issues++;
        mod.details.push(`error: TTFB > 2000ms — server is very slow`);
        mod.status = 'failed';
      } else if (ttfb > 800) {
        mod.issues++;
        mod.details.push(`warning: TTFB > 800ms — consider optimising`);
        if (mod.status !== 'failed') mod.status = 'warning';
      } else {
        mod.details.push(`pass: TTFB under 800ms`);
      }

      // Check compression — the request carries Accept-Encoding (see
      // COMPRESSION_ACCEPT_ENCODING), so a server answering `identity` here
      // genuinely does not compress; it is not just unasked.
      mod.checks++;
      const encoding = headers['content-encoding'];
      if (encoding && encoding !== 'identity') {
        mod.details.push(`pass: ${encoding} compression (Content-Encoding: ${encoding})`);
      } else {
        mod.issues++;
        mod.details.push(`warning: No compression (gzip/brotli) — larger payloads (sent Accept-Encoding: ${COMPRESSION_ACCEPT_ENCODING}, server did not compress)`);
      }

      // Check cache headers
      mod.checks++;
      const cacheControl = headers['cache-control'];
      if (cacheControl) {
        mod.details.push(`info: Cache-Control: ${cacheControl}`);
      } else {
        mod.details.push('info: No Cache-Control header');
      }

      // Status code check
      mod.checks++;
      if (statusCode >= 200 && statusCode < 300) {
        mod.details.push(`pass: HTTP ${statusCode}`);
      } else if (statusCode >= 300 && statusCode < 400) {
        mod.details.push(`info: HTTP ${statusCode} redirect`);
      } else {
        mod.issues++;
        mod.details.push(`error: HTTP ${statusCode}`);
        mod.status = 'failed';
      }
    } catch (err) {
      mod.issues++;
      mod.details.push(`error: Request failed — ${err.message}`);
      mod.status = 'failed';
    }

    return mod;
  }

  async _checkAvailability(url) {
    const mod = { status: 'passed', checks: 0, issues: 0, details: [] };
    const parsed = new URL(url);

    // Check HTTPS availability
    mod.checks++;
    if (parsed.protocol === 'http:') {
      const httpsUrl = url.replace('http://', 'https://');
      try {
        await this._timedRequest(httpsUrl);
        mod.details.push('pass: HTTPS version available');
      } catch {
        mod.issues++;
        mod.details.push('error: HTTPS not available');
        mod.status = 'failed';
      }
    } else {
      mod.details.push('pass: Using HTTPS');
    }

    // Check HTTP → HTTPS redirect
    mod.checks++;
    if (parsed.protocol === 'https:') {
      const httpUrl = url.replace('https://', 'http://');
      try {
        const { statusCode, headers } = await this._timedRequest(httpUrl, false);
        if (statusCode >= 300 && statusCode < 400 && headers.location?.startsWith('https://')) {
          mod.details.push('pass: HTTP redirects to HTTPS');
        } else {
          mod.issues++;
          mod.details.push('warning: HTTP does not redirect to HTTPS');
        }
      } catch {
        mod.details.push('info: HTTP not reachable (may be blocked)');
      }
    }

    // Check www vs non-www
    mod.checks++;
    const hasWww = parsed.hostname.startsWith('www.');
    const altHostname = hasWww ? parsed.hostname.slice(4) : `www.${parsed.hostname}`;
    const altUrl = `${parsed.protocol}//${altHostname}${parsed.pathname}`;
    try {
      const { statusCode } = await this._timedRequest(altUrl);
      if (statusCode >= 200 && statusCode < 400) {
        mod.details.push(`pass: ${altHostname} reachable (status ${statusCode})`);
      }
    } catch {
      mod.details.push(`info: ${altHostname} not reachable`);
    }

    return mod;
  }

  _fetchHeaders(url) {
    return new Promise((resolve) => {
      const client = url.startsWith('https') ? https : http;
      const req = client.request(url, { method: 'HEAD', timeout: 10000 }, (res) => {
        resolve(res.headers);
      });
      req.on('error', () => resolve(null));
      req.setTimeout(10000, () => { req.destroy(); resolve(null); });
      req.end();
    });
  }

  _timedRequest(url, followRedirects = true) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const req = client.request(url, {
        method: 'GET',
        timeout: 15000,
        headers: {
          'User-Agent': 'GateTest/1.0 ServerScanner',
          'Accept-Encoding': COMPRESSION_ACCEPT_ENCODING,
        },
      }, (res) => {
        if (followRedirects && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this._timedRequest(res.headers.location, true).then(resolve).catch(reject);
          res.resume();
          return;
        }
        res.resume();
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers }));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
  }
}

module.exports = ServerScanner;
