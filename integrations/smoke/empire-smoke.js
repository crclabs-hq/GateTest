/**
 * Empire Smoke Scanner
 *
 * Fast cross-product smoke probes over Craig's three live deployments
 * (platform hosts from website/app/lib/platform-config.js — Tallrig today):
 *   - tallrig.com homepage          (200 + body says the platform's name)
 *   - api.tallrig.com /api/health   (status:"ok")
 *   - crontech.ai -> tallrig.com    (the rename redirect still stands)
 *   - gluecron.com apex             (soft-skip on NXDOMAIN)
 *   - gluecron.com platform-status  (healthy:true)
 *   - gatetest platform-status      (healthy:true AND a real commit)
 *   - tallrig.com:443 TLS expiry    (warn <14d)
 *
 * RENAMED AGAIN 2026-09-14: Vapron became Tallrig ("vapron is no longer" —
 * Craig). Measured 2026-09-15 before flipping the config defaults:
 *
 *     https://tallrig.com/               -> 200, body says "Tallrig" (and
 *                                           NOT "vapron" — the old keyword
 *                                           would have failed a healthy site)
 *     https://api.tallrig.com/api/health -> 200 {"status":"ok"}
 *     https://crontech.ai/               -> 301 to https://tallrig.com/
 *     https://vapron.ai/                 -> 200, same box, Tallrig-branded
 *
 * TARGETS CORRECTED 2026-08-29. Crontech was renamed Vapron on 2026-06-12 and
 * this file was never updated, so three of its five probes could not have
 * passed. Measured before rewriting, not assumed:
 *
 *     https://crontech.ai/              -> 301 to https://vapron.ai/
 *     https://api.crontech.ai/api/health -> 000 (host does not resolve)
 *     https://gluecron.crontech.ai/      -> 000 (host does not resolve)
 *     https://vapron.ai/                 -> 200, body says "Vapron"
 *     https://api.vapron.ai/api/health   -> 200
 *
 * Two failures were baked in beyond the hostnames:
 *   1. The homepage probe required the body to contain "Crontech". vapron.ai
 *      serves "Vapron", so it would have failed on a perfectly healthy site.
 *   2. The health probe required `ok: true`, but Vapron answers
 *      `{"status":"ok","checks":[...]}`. Correct host, still red.
 * Both are why a probe nobody runs is worse than no probe: it rots silently
 * and you only discover it the day you need it.
 *
 * The `crontech-redirect` probe exists because the redirect is load-bearing —
 * every link, bookmark and doc written before the rename depends on it, and
 * nothing else in the estate would notice if it broke.
 *
 * `gatetest-status` additionally asserts the reported commit is not
 * "unknown"/empty: a deployment serving an unidentifiable build is the
 * KI #79 class (production silently stale) and a green homepage hides it.
 *
 * KNOWN GAP, deliberately not faked: vapron.ai has no /api/platform-status
 * (404 as of 2026-08-29), so it is probed via its homepage + api health
 * instead. Gluecron answers the contract but reports version "dev" /
 * commit "unknown" — that is KI #81, tracked there, and NOT asserted here
 * because a probe that fails on a known-open issue is just noise.
 *
 * All probes run in parallel. A probe answering in over SLOW_MS (5s) is
 * downgraded to a warning; one that has not answered by DEFAULT_TIMEOUT_MS
 * (20s) is treated as down. "Up but slow" and "down" are different
 * operational facts and deliberately do not share a colour.
 * `runEmpireSmoke` returns a structured SmokeReport for dashboards or alerts.
 *
 * The `fetch` and DNS/TLS primitives are all injectable so tests can exercise
 * the aggregation logic without touching the network.
 */

const dnsPromises = require('dns').promises;
const tls = require('tls');
const { siteUrl } = require('../../src/core/site-url.js');

// A probe that has not answered in 20s is treated as DOWN. This is a hard
// ceiling, not a latency budget — see SLOW_MS.
const DEFAULT_TIMEOUT_MS = 20000;

// Above this, a probe that SUCCEEDED is downgraded to a warning. "Up but
// slow" and "down" are different operational facts and must not share a
// colour.
//
// Measured 2026-08-29, and the spread is the whole argument: vapron.ai's
// 365KB homepage took 1.5s / 9.2s / 19.8s from a New Zealand dev box, and
// ~300ms from a GitHub runner — the SAME page, the same minute. TTFB was
// 0.5-3.7s in both cases, so the server answers promptly and it is bulk
// transfer over one network path that drags.
//
// A 5s hard timeout therefore reported a perfectly healthy site as DOWN,
// depending only on where you probed from. Latency is a property of the
// path as much as the server, so it cannot be allowed to mean "outage" —
// and a monitor that cries wolf gets muted, after which it protects nobody.
const SLOW_MS = 5000;

const CERT_WARN_DAYS = 14;

// Platform hostnames and the brand keyword come from
// website/app/lib/platform-config.js — the platform has been renamed twice
// (Crontech → Vapron → Tallrig); the probes follow an env change, not an
// edit here.
const platform = require('../../website/app/lib/platform-config');

const DEFAULT_URLS = {
  platformHome: `${platform.PLATFORM_SITE_URL}/`,
  platformApiHealth: `${platform.PLATFORM_API_URL}/api/health`,
  /** The word a healthy platform homepage must contain (its product name). */
  platformKeyword: platform.PLATFORM_NAME,
  // The rename redirect. Must keep answering 3xx and FINALLY land on the
  // platform's canonical host (one intermediate hop is tolerated during a
  // rename window, e.g. crontech.ai -> vapron.ai -> tallrig.com).
  crontechRedirect: 'https://crontech.ai/',
  redirectHost: platform.platformCanonicalHost(),
  gluecronApex: 'https://gluecron.com/',
  gluecronStatus: 'https://gluecron.com/api/platform-status',
  // Never a literal — the domain lives in exactly one place (Bible: THE DOMAIN).
  gatetestStatus: siteUrl('/api/platform-status'),
  certHost: platform.PLATFORM_HOST,
  certPort: 443,
};

/**
 * Run a promise-producing function with a timeout. Rejects with a labeled
 * error if the wrapped promise does not settle in time.
 */
function withTimeout(label, fn, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    Promise.resolve()
      .then(fn)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Wrap a probe so it always resolves to a probe result object (pass/warn/fail
 * /skip) and records latency, regardless of how the underlying work settled.
 */
async function runProbe(name, fn, timeoutMs, slowMs = SLOW_MS) {
  const started = Date.now();
  try {
    const result = await withTimeout(name, fn, timeoutMs);
    const latency = Date.now() - started;

    // Up but slow is a warning, never a pass and never a failure.
    if (result.status === 'pass' && latency > slowMs) {
      return {
        name,
        status: 'warn',
        latency_ms: latency,
        detail: `${result.detail} (slow: ${latency}ms > ${slowMs}ms)`,
      };
    }

    return {
      name,
      status: result.status,
      latency_ms: latency,
      detail: result.detail,
    };
  } catch (err) {
    return {
      name,
      status: 'fail',
      latency_ms: Date.now() - started,
      detail: err && err.message ? err.message : 'unknown error',
    };
  }
}

/**
 * Probe: the platform homepage. Expect 200, HTTP/2, body mentioning the
 * platform's product name (PLATFORM_NAME — "Tallrig" today).
 *
 * The keyword is the point: a 200 from a parked page, a stray Caddy default,
 * or a misrouted vhost all look identical to a status-code-only check. And
 * the keyword must be the CURRENT name: tallrig.com's body has zero
 * occurrences of "vapron" (measured 2026-09-15), so the old literal would
 * have failed a healthy site exactly as "Crontech" did in 2026-08.
 */
async function probePlatformHome(fetchFn, url, keyword = platform.PLATFORM_NAME) {
  const res = await fetchFn(url, { method: 'GET', redirect: 'follow' });
  if (!res || res.status !== 200) {
    return { status: 'fail', detail: `expected 200, got ${res && res.status}` };
  }

  const body = typeof res.text === 'function' ? await res.text() : '';
  const warnings = [];

  // httpVersion is non-standard but populated by several fetch shims; treat
  // missing as "unknown" rather than a hard failure.
  const httpVersion = res.httpVersion || (res.headers && typeof res.headers.get === 'function' && res.headers.get('x-http-version'));
  if (httpVersion && !/^2|^3/.test(String(httpVersion))) {
    warnings.push(`http version ${httpVersion} (expected h2/h3)`);
  }

  const keywordRe = new RegExp(String(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  if (!body || !keywordRe.test(body)) {
    return { status: 'fail', detail: `body missing "${keyword}" keyword` };
  }

  if (warnings.length > 0) {
    return { status: 'warn', detail: warnings.join('; ') };
  }
  return { status: 'pass', detail: 'home 200 + body ok' };
}

/**
 * Probe: an API health endpoint.
 *
 * Accepts BOTH shapes in use across the estate — Vapron answers
 * `{"status":"ok","checks":[...]}` while others answer `{"ok":true}`. The
 * previous version demanded `ok:true` only, which would have failed Vapron
 * even once pointed at the right host.
 *
 * When a `checks` array is present, a single failing check degrades to warn:
 * the service is answering, but something behind it is not.
 */
async function probeApiHealth(fetchFn, url) {
  const res = await fetchFn(url, { method: 'GET' });
  if (!res || res.status !== 200) {
    return { status: 'fail', detail: `expected 200, got ${res && res.status}` };
  }
  let payload;
  try {
    payload = typeof res.json === 'function' ? await res.json() : null;
  } catch (err) {
    return { status: 'fail', detail: `invalid JSON: ${err.message}` };
  }
  if (!payload) {
    return { status: 'fail', detail: 'empty health payload' };
  }

  const healthy = payload.ok === true || payload.status === 'ok' || payload.healthy === true;
  if (!healthy) {
    return { status: 'fail', detail: 'health payload not ok' };
  }

  if (Array.isArray(payload.checks)) {
    const failed = payload.checks.filter((c) => c && c.ok === false).map((c) => c.name || '?');
    if (failed.length > 0) {
      return { status: 'warn', detail: `subcheck(s) failing: ${failed.join(', ')}` };
    }
  }
  return { status: 'pass', detail: 'health ok' };
}

/**
 * Probe: a permanent redirect still points where it should.
 *
 * Guards the crontech.ai -> platform rename (crontech.ai -> tallrig.com today). Every pre-rename link, bookmark and
 * doc depends on this hop, and nothing else in the estate would notice if it
 * quietly stopped resolving.
 */
/** Hops followed before the chain is declared not to reach expectedHost. */
const MAX_REDIRECT_HOPS = 3;

async function probeRedirect(fetchFn, url, expectedHost) {
  // Follow the chain by hand, one hop at a time, and pass as soon as a hop
  // lands on expectedHost. During a rename window the legacy host may 301
  // to the previous name, which then 301s to the new one — the FINAL
  // destination is what matters, not the first Location header.
  let current = url;
  const hops = [];
  let lastHost = null;
  for (let i = 0; i < MAX_REDIRECT_HOPS; i += 1) {
    let res;
    try {
      res = await fetchFn(current, { method: 'GET', redirect: 'manual' });
    } catch (err) { // error-ok — the FIRST hop's failure is the probe's failure (rethrown); a later hop that cannot be reached is reported as "redirects to X, expected Y" with the reason, which is the verdict a rename-window monitor needs
      if (!lastHost) throw err;
      return { status: 'fail', detail: `redirects to ${lastHost}, expected ${expectedHost} (${lastHost} unreachable: ${err && err.message ? err.message : err})` };
    }
    if (!res) {
      return { status: 'fail', detail: hops.length ? `no response from ${current} after ${hops.join(', ')}` : 'no response' };
    }
    if (res.status < 300 || res.status > 399) {
      return lastHost
        ? { status: 'fail', detail: `redirects to ${lastHost}, expected ${expectedHost}` }
        : { status: 'fail', detail: `expected a 3xx redirect, got ${res.status}` };
    }
    const location = res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('location')
      : null;
    if (!location) {
      return { status: 'fail', detail: `${res.status} with no Location header` };
    }
    let next;
    try {
      next = new URL(location, current);
    } catch {
      return { status: 'fail', detail: `unparseable Location: ${location}` };
    }
    hops.push(`${res.status} -> ${next.hostname}`);
    lastHost = next.hostname;
    if (next.hostname === expectedHost) {
      return { status: 'pass', detail: hops.join(', ') };
    }
    current = next.href;
  }
  return { status: 'fail', detail: `redirect chain (${hops.join(', ')}) did not reach ${expectedHost} within ${MAX_REDIRECT_HOPS} hops` };
}

/**
 * Probe: gluecron.com apex. NXDOMAIN (DNS not yet configured) downgrades to
 * a "skip" with an info-level detail; other failures are hard fails.
 */
async function probeGluecronApex(fetchFn, resolveFn, url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return { status: 'fail', detail: `invalid url ${url}` };
  }

  try {
    await resolveFn(host);
  } catch (err) {
    if (err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA')) {
      return { status: 'skip', detail: 'DNS not yet configured' };
    }
    return { status: 'fail', detail: `dns error: ${err && err.message}` };
  }

  const res = await fetchFn(url, { method: 'GET', redirect: 'follow' });
  if (res && res.status === 200) {
    return { status: 'pass', detail: 'apex 200' };
  }
  return { status: 'fail', detail: `apex status ${res && res.status}` };
}

/**
 * Probe: the shared /api/platform-status contract (docs/PLATFORM_STATUS.md).
 *
 * `requireCommit` additionally asserts the build identifies itself. A
 * deployment reporting commit "unknown" is the KI #79 failure — production
 * silently running something nobody can name — and a green homepage hides it
 * completely. Only asked of products known to populate the field.
 */
async function probePlatformStatus(fetchFn, url, { requireCommit = false } = {}) {
  const res = await fetchFn(url, { method: 'GET' });
  if (!res || res.status !== 200) {
    return { status: 'fail', detail: `expected 200, got ${res && res.status}` };
  }
  let payload;
  try {
    payload = typeof res.json === 'function' ? await res.json() : null;
  } catch (err) {
    return { status: 'fail', detail: `invalid JSON: ${err.message}` };
  }
  if (!payload) {
    return { status: 'fail', detail: 'empty status payload' };
  }
  if (payload.healthy !== true) {
    return { status: 'fail', detail: `healthy=${payload.healthy}` };
  }
  if (requireCommit) {
    const commit = String(payload.commit || '').trim();
    if (!commit || commit === 'unknown') {
      return { status: 'warn', detail: 'healthy but commit is "unknown" — cannot tell what is deployed' };
    }
    return { status: 'pass', detail: `healthy @ ${commit.slice(0, 8)}` };
  }
  return { status: 'pass', detail: 'healthy' };
}

/**
 * Probe: TLS certificate for host:port. Warn if notAfter is within
 * CERT_WARN_DAYS.
 */
async function probeCert(tlsConnectFn, host, port) {
  const cert = await tlsConnectFn(host, port);
  if (!cert || !cert.valid_to) {
    return { status: 'fail', detail: 'no cert presented' };
  }
  const notAfter = new Date(cert.valid_to);
  if (Number.isNaN(notAfter.getTime())) {
    return { status: 'fail', detail: `unparseable notAfter: ${cert.valid_to}` };
  }
  const msLeft = notAfter.getTime() - Date.now();
  const daysLeft = Math.floor(msLeft / (24 * 60 * 60 * 1000));
  if (daysLeft < 0) {
    return { status: 'fail', detail: `cert expired ${-daysLeft}d ago` };
  }
  if (daysLeft < CERT_WARN_DAYS) {
    return { status: 'warn', detail: `cert expires in ${daysLeft}d` };
  }
  return { status: 'pass', detail: `cert valid ${daysLeft}d` };
}

/**
 * Default TLS probe — opens a TLS socket and returns the peer certificate.
 */
function defaultTlsConnect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: true },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        resolve(cert);
      }
    );
    socket.once('error', (err) => reject(err));
  });
}

/**
 * Roll up per-probe statuses into an overall empire status.
 *   - any fail     -> red
 *   - any warn     -> yellow
 *   - otherwise    -> green   (skips do not degrade status)
 */
function rollup(probes) {
  if (probes.some((p) => p.status === 'fail')) return 'red';
  if (probes.some((p) => p.status === 'warn')) return 'yellow';
  return 'green';
}

/**
 * Render a compact human-readable markdown summary table.
 */
function renderMarkdown(status, timestamp, probes) {
  const icon = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' };
  const lines = [
    `### Empire Smoke: ${status.toUpperCase()} (${timestamp})`,
    '',
    '| Probe | Status | Latency | Detail |',
    '| --- | --- | --- | --- |',
  ];
  for (const p of probes) {
    const detail = (p.detail || '').replace(/\|/g, '\\|');
    lines.push(`| ${p.name} | ${icon[p.status] || p.status} | ${p.latency_ms}ms | ${detail} |`);
  }
  return lines.join('\n');
}

/**
 * Run all empire smoke probes in parallel.
 *
 * @param {object} [opts]
 * @param {object} [opts.urls] Override target URLs/host (see DEFAULT_URLS).
 * @param {Function} [opts.fetch] Fetch implementation (defaults to global fetch).
 * @param {Function} [opts.resolve] DNS resolve (defaults to dns.promises.resolve).
 * @param {Function} [opts.tlsConnect] TLS cert fetcher (defaults to tls.connect).
 * @param {number} [opts.timeoutMs] Per-probe timeout (default 5000).
 * @returns {Promise<{status:string, timestamp:string, probes:Array, markdown:string}>}
 */
async function runEmpireSmoke(opts = {}) {
  const urls = Object.assign({}, DEFAULT_URLS, opts.urls || {});
  const fetchFn = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  const resolveFn = opts.resolve || ((host) => dnsPromises.resolve(host));
  const tlsConnectFn = opts.tlsConnect || defaultTlsConnect;
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const slowMs = typeof opts.slowMs === 'number' ? opts.slowMs : SLOW_MS;

  if (!fetchFn) {
    throw new Error('runEmpireSmoke: no fetch implementation available (Node <18?). Pass opts.fetch.');
  }

  const timestamp = new Date().toISOString();

  const probes = await Promise.all([
    runProbe('platform-home', () => probePlatformHome(fetchFn, urls.platformHome, urls.platformKeyword), timeoutMs, slowMs),
    runProbe('platform-api-health', () => probeApiHealth(fetchFn, urls.platformApiHealth), timeoutMs, slowMs),
    runProbe('crontech-redirect', () => probeRedirect(fetchFn, urls.crontechRedirect, urls.redirectHost), timeoutMs, slowMs),
    runProbe('gluecron-apex', () => probeGluecronApex(fetchFn, resolveFn, urls.gluecronApex), timeoutMs, slowMs),
    runProbe('gluecron-status', () => probePlatformStatus(fetchFn, urls.gluecronStatus), timeoutMs, slowMs),
    runProbe('gatetest-status', () => probePlatformStatus(fetchFn, urls.gatetestStatus, { requireCommit: true }), timeoutMs, slowMs),
    runProbe('cert-platform', () => probeCert(tlsConnectFn, urls.certHost, urls.certPort), timeoutMs, slowMs),
  ]);


  const status = rollup(probes);
  const markdown = renderMarkdown(status, timestamp, probes);

  return { status, timestamp, probes, markdown };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                  */
/*                                                                      */
/* Invoked by .github/workflows/empire-smoke.yml. Exit codes are the    */
/* alert channel:                                                       */
/*                                                                      */
/*   0  green, or yellow (a warning is surfaced, not paged)             */
/*   1  red — a probe failed, or the runner itself blew up              */
/*                                                                      */
/* Yellow exits 0 on purpose. A cert 13 days from expiry is real and    */
/* worth seeing, but failing every run for 13 consecutive days trains   */
/* everyone to ignore the job — and a monitor people ignore is worse    */
/* than no monitor. Pass --fail-on-warn when you want strictness.       */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const failOnWarn = argv.includes('--fail-on-warn');

  runEmpireSmoke()
    .then((report) => {
      process.stdout.write(
        (asJson ? JSON.stringify(report, null, 2) : report.markdown) + '\n'
      );
      const bad = report.status === 'red' || (failOnWarn && report.status === 'yellow');
      process.exit(bad ? 1 : 0);
    })
    .catch((err) => {
      process.stderr.write(`empire-smoke: ${(err && err.message) || 'unknown error'}\n`);
      process.exit(1);
    });
}

module.exports = {
  runEmpireSmoke,
  SLOW_MS,
  DEFAULT_TIMEOUT_MS,
  // exported for tests / downstream composition
  DEFAULT_URLS,
  rollup,
  renderMarkdown,
  probePlatformHome,
  probeApiHealth,
  probeRedirect,
  probeGluecronApex,
  probePlatformStatus,
  probeCert,
};
