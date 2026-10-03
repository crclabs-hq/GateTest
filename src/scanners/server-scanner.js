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
const net = require('net');
const tls = require('tls');
const { detectTlsIntercept } = require('../core/tls-intercept');
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

  /**
   * `--server --format json` groups (issue #677 item 1) — one `checks`
   * entry per `details` line, the ONE place a check's severity actually
   * lives (see countSeverities above). Each module's `details` strings are
   * always `<severity>: <message>`, written by the individual `_check*`
   * methods below.
   */
  static toJsonGroups(result) {
    return (result.modules || []).map((mod) => ({
      name: mod.name,
      checks: (mod.details || []).map((d, i) => {
        const m = /^(error|warning|pass|info):\s*(.*)$/.exec(d);
        const type = m ? m[1] : 'info';
        const message = m ? m[2] : d;
        return {
          name: `${mod.name}.${i + 1}`,
          passed: type !== 'error' && type !== 'warning',
          severity: type === 'pass' ? 'info' : type,
          message,
        };
      }),
    }));
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

    this._tlsVerdict = null;
    const sslCheck = this._checkSSL(parsed);
    this._sslCheck = sslCheck;
    const moduleResults = await Promise.allSettled([
      sslCheck,
      this._checkHeaders(url),
      this._checkDNS(parsed.hostname),
      this._checkPerformance(url, { sslCheck }),
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

  async _checkSSL(parsed, env = process.env) {
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
        const cert = socket.getPeerCertificate(true);

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

        // Check expiry — unless the certificate is a local intercepting proxy's
        // (then its issuer and expiry say nothing about the site).
        mod.checks++;
        const verdict = detectTlsIntercept({ cert, env });
        this._tlsVerdict = verdict;
        this._checkExpiry(mod, cert, verdict);

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

  /** Cert-expiry finding, or the not-checked answer when TLS is intercepted. */
  _checkExpiry(mod, cert, verdict) {
    if (verdict && verdict.intercepted) {
      const issuer = (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || 'unknown';
      mod.details.push(`info: SSL certificate expiry not checked — TLS intercepted by a local proxy (${verdict.reason}; the certificate seen was issued by ${issuer}, not the site's own CA)`);
      return;
    }
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

  /**
   * DNS & e-mail posture (issue #807 R4: `dnsPosture` / `mailPosture`).
   *
   * Three states per record, never two. A resolver that answered
   * ENOTFOUND / ENODATA has PROVED the record absent; a resolver that timed
   * out, SERVFAILed or refused has proved nothing, and the old code printed
   * "warning: No DMARC record" for both — a false claim on every flaky
   * lookup. Now a resolver failure reads NOT CHECKED with the code.
   *
   * Two claims removed because they were not true: "DMARC reference found"
   * fired on the APEX TXT containing the substring `_dmarc` or `v=DMARC1`,
   * but DMARC policy lives only at `_dmarc.<domain>` — text at the apex is
   * not a policy; and "DMARC record found" fired on ANY TXT at `_dmarc.`,
   * `v=DMARC1` or not, `p=none` or not. SPF likewise "found" a record that
   * ended `+all` (authorises the whole internet) as a pass.
   *
   * `resolver` is injectable for tests; production passes node's `dns`.
   */
  async _checkDNS(hostname, resolver = dns) {
    const mod = { status: 'passed', checks: 0, issues: 0, details: [] };

    if (net.isIP(hostname)) {
      mod.checks++;
      mod.details.push(`info: NOT CHECKED — ${hostname} is an IP literal; A/AAAA/MX/SPF/DMARC apply to domain names`);
      return mod;
    }

    await this._checkAddressRecords(mod, hostname, resolver);
    await this._checkMailRecords(mod, hostname, resolver);
    return mod;
  }

  /** One lookup → `{ ok, value }`, `{ absent: true }` or `{ failed: code }`. */
  _resolve(resolver, method, ...args) {
    return new Promise((resolve) => {
      resolver[method](...args, (err, value) => {
        if (!err) return resolve({ ok: true, value });
        const code = err.code || 'UNKNOWN';
        if (code === 'ENOTFOUND' || code === 'ENODATA') return resolve({ absent: true, code });
        return resolve({ failed: code });
      });
    });
  }

  async _checkAddressRecords(mod, hostname, resolver) {
    // A records, with the OS resolver as the fallback (follows CNAMEs,
    // matches nslookup behaviour).
    mod.checks++;
    const a = await this._resolve(resolver, 'resolve4', hostname);
    if (a.ok) {
      mod.details.push(`pass: ${a.value.length} A record(s) → ${a.value.join(', ')}`);
    } else {
      const lookup = await this._resolve(resolver, 'lookup', hostname, { family: 4 });
      if (lookup.ok) {
        mod.details.push(`pass: Resolves to ${lookup.value} (via CNAME chain)`);
      } else if (lookup.absent && (a.absent || a.failed)) {
        mod.issues++;
        mod.details.push('error: Hostname does not resolve');
      } else {
        mod.details.push(`info: NOT CHECKED — A lookup failed at the resolver (${a.failed || lookup.failed}), not proven absent`);
      }
    }

    mod.checks++;
    const aaaa = await this._resolve(resolver, 'resolve6', hostname);
    if (aaaa.ok) mod.details.push('pass: IPv6 (AAAA) record found');
    else if (aaaa.absent) mod.details.push('info: No IPv6 (AAAA) record');
    else mod.details.push(`info: NOT CHECKED — AAAA lookup failed at the resolver (${aaaa.failed})`);
  }

  async _checkMailRecords(mod, hostname, resolver) {
    mod.checks++;
    const mx = await this._resolve(resolver, 'resolveMx', hostname);
    if (mx.ok) mod.details.push(`pass: ${mx.value.length} MX record(s) found`);
    else if (mx.absent) mod.details.push('info: No MX records (not an email domain)');
    else mod.details.push(`info: NOT CHECKED — MX lookup failed at the resolver (${mx.failed})`);

    // SPF lives in the apex TXT set; DMARC policy lives ONLY at _dmarc.<domain>.
    mod.checks++;
    const txt = await this._resolve(resolver, 'resolveTxt', hostname);
    if (txt.ok || txt.absent) {
      const records = txt.ok ? txt.value.map((r) => r.join('')) : [];
      this._judgeSpf(mod, records);
    } else {
      mod.details.push(`info: NOT CHECKED — SPF: TXT lookup failed at the resolver (${txt.failed})`);
    }

    mod.checks++;
    const dmarc = await this._resolve(resolver, 'resolveTxt', `_dmarc.${hostname}`);
    if (dmarc.ok) {
      this._judgeDmarc(mod, dmarc.value.map((r) => r.join('')));
    } else if (dmarc.absent) {
      mod.issues++;
      mod.details.push('warning: No DMARC record — email authentication not configured');
    } else {
      mod.details.push(`info: NOT CHECKED — DMARC: _dmarc TXT lookup failed at the resolver (${dmarc.failed})`);
    }
  }

  _judgeSpf(mod, records) {
    const spf = records.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
    if (spf.length === 0) {
      mod.issues++;
      mod.details.push('warning: No SPF record — email spoofing risk');
      return;
    }
    if (spf.length > 1) {
      mod.issues++;
      mod.details.push(`warning: ${spf.length} SPF records — RFC 7208 allows one; receivers treat this as a permanent error`);
      return;
    }
    const terms = spf[0].trim().split(/\s+/).slice(1);
    const all = terms.find((t) => /^[-~+?]?all$/i.test(t));
    const redirect = terms.find((t) => /^redirect=/i.test(t));
    if (!all && !redirect) {
      mod.issues++;
      mod.details.push('warning: SPF record has no "all" mechanism — unlisted senders are treated as neutral, spoofing not prevented');
    } else if ((all && /^[+?]/.test(all)) || all === 'all') {
      mod.issues++;
      mod.details.push(`warning: SPF record ends in ${all} — authorises every sender, spoofing not prevented`);
    } else {
      mod.details.push(`pass: SPF record found (${all || redirect})`);
    }
  }

  _judgeDmarc(mod, records) {
    const policy = records.find((r) => /^v=DMARC1(\s|;|$)/i.test(r.trim()));
    if (!policy) {
      mod.issues++;
      mod.details.push('warning: TXT present at _dmarc but none is a DMARC record (v=DMARC1) — email authentication not configured');
      return;
    }
    const p = /(?:^|;)\s*p\s*=\s*([a-z]+)/i.exec(policy);
    const value = p ? p[1].toLowerCase() : null;
    if (value === 'reject' || value === 'quarantine') {
      mod.details.push(`pass: DMARC record found (p=${value})`);
    } else if (value === 'none') {
      mod.issues++;
      mod.details.push('warning: DMARC p=none — monitoring only, spoofed mail is still delivered');
    } else {
      mod.issues++;
      mod.details.push('warning: DMARC record has no valid p= policy — receivers ignore it');
    }
  }

  async _checkPerformance(url, { sslCheck } = {}) {
    const mod = { status: 'passed', checks: 0, issues: 0, details: [] };

    // Through an intercepting proxy every request pays the proxy's hop, so a
    // TTFB number is about the proxy, not the site: not checked (info).
    if (/^https:/i.test(url)) {
      let verdict = { intercepted: false, reason: null };
      if (sslCheck) {
        try { await sslCheck; } catch { /* error-ok — the ssl module reports its own failure */ }
        verdict = this._tlsVerdict || verdict;
      }
      if (verdict.intercepted) {
        mod.details.push(`info: TTFB not checked — TLS intercepted by a local proxy (${verdict.reason}); the timing would measure the proxy, not the site`);
        return mod;
      }
    }

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
