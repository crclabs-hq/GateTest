/**
 * Estate Module — every host the target owns, not just the one you pointed at.
 *
 * `gatetest --crawl https://tallrig.com` reported PASSED while
 * alecrae.tallrig.app answered 503 and gatetest.tallrig.app, marco-demo,
 * selftest-dns-elsewhere-* and vapron-deploy-canary answered 502: a crawl
 * never leaves the apex, so a "gateway up, app dead" host beside it is
 * invisible. This module discovers the sibling hosts and gives each one a
 * verdict from the outside.
 *
 * Host discovery — each source deterministic, each reported in the summary:
 *   list     `modules.estate.hosts`, a `hosts.txt` at the project root, `--hosts a,b`
 *   sitemap  every distinct hostname in /sitemap.xml, its sitemap-index children
 *            on the target host, and the `Sitemap:` lines of /robots.txt
 *   SAN      the target's TLS certificate subjectAltName. A wildcard entry
 *            cannot be enumerated: it is reported as not-checked, never
 *            turned into a host.
 *   links    same-site `<a href>` hostnames on the start page
 *   Anything only a zone export or the platform's own tenant list knows (the
 *   five *.tallrig.app hosts are in none of the four sources above when the
 *   target is tallrig.com) has to arrive through `list`.
 *
 * Per host, one DNS resolve (A/AAAA) and ONE https request (`GET /`, 10 s,
 * TLS facts read off that same connection), never redirects followed:
 *
 *   ok                     2xx, or 3xx to a host in the discovered set
 *   gateway-up-app-dead    502/503/504 — the proxy answers, the app behind it does not
 *   dead                   NXDOMAIN / no A+AAAA / connection refused / timeout / TLS handshake refused.
 *                          An NXDOMAIN from the system resolver only counts once an independent
 *                          resolver (`modules.estate.resolvers`, default 1.1.1.1 + 8.8.8.8) agrees;
 *                          a positive answer from any of them wins and the disagreement is printed.
 *   unexpected-ip          resolves outside `expectedIps` / `expectedCidrs`
 *                          (the address family is only judged when the allowlist
 *                          names at least one entry of that family)
 *   redirects-off-estate   `/` redirects to a host that was not discovered
 *   auth-wall              401 / 403
 *   http-error             any other 4xx (warning) or 5xx (error)
 *   not-checked            DNS lookup itself failed (timeout/SERVFAIL), a
 *                          non-public address (set `allowPrivate: true` to probe
 *                          internal hosts), 429, or the budget/host cap was hit
 *
 * Precedence when one host trips several: dead > unexpected-ip >
 * gateway-up-app-dead > redirects-off-estate > auth-wall; the message names
 * the runner-up. Error: gateway-up-app-dead, dead, unexpected-ip, 5xx,
 * expired certificate. Warning: auth-wall, redirects-off-estate, 4xx,
 * expiring / mismatched / untrusted certificate.
 *
 * Limits: concurrency 5, one request per host, `maxHosts` (default 50) and
 * `budgetMs` (default 45000); hosts beyond either are listed as not-checked.
 * HTTPS on 443 only. Runs in the `full`, `nuclear` and `wp` suites — not
 * `quick` or `standard`, which stay offline-fast.
 *
 * Seams (constructor deps) exist so the control pairs need no network:
 * `resolve(host)`, `probe({host, ip, family, timeoutMs})`,
 * `fetchText(url)`, `tlsSans(host)`.
 *
 * TODO(#802): declare `estate` in CRAWL_CAPABLE_MODULES once that set lands on main.
 */

'use strict';

const dns = require('dns');
const fs = require('fs');
const https = require('https');
const net = require('net');
const path = require('path');
const tls = require('tls');
const BaseModule = require('./base-module');

const CONCURRENCY = 5;
const PROBE_TIMEOUT_MS = 10000;
const DEFAULT_MAX_HOSTS = 50;
const DEFAULT_BUDGET_MS = 45000;
const MAX_SITEMAPS = 10;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const BODY_SNIPPET_BYTES = 4096;
const TLS_EXPIRING_DAYS = 14;
// Independent resolvers that must agree before a name is called dead. Only the
// hostname being probed is ever sent to them, and only on an NXDOMAIN; set
// `modules.estate.resolvers: []` to keep every query on the system resolver.
const DEFAULT_CONFIRM_RESOLVERS = ['1.1.1.1', '8.8.8.8'];
const SOURCE_ORDER = ['target', 'list', 'sitemap', 'san', 'links'];

const GATEWAY_SERVER_RE = /traefik|nginx|envoy|caddy|haproxy|cloudflare|awselb|istio|varnish|openresty|squid|apache traffic|\bbun\b|tallrig/i;
const GATEWAY_BODY_RE = /bad gateway|service unavailable|gateway time-?out|no available server|upstream|502|503|504/i;
const SHORT_BODY_BYTES = 1024;

// Hosts of two labels under a country-code second level: `example.co.uk` is
// one site, `co.uk` is not. Not the full public-suffix list — only the
// suffixes a site-of-record is realistically on; an unlisted one degrades to
// "treat as two labels" (a link may be judged off-site and not followed,
// never the reverse).
const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz',
  'co.jp', 'co.za', 'com.br', 'com.mx', 'co.in', 'com.cn', 'com.sg', 'com.hk', 'co.kr',
]);

const NON_PUBLIC = (() => {
  const l = new net.BlockList();
  for (const [a, p] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ]) l.addSubnet(a, p, 'ipv4');
  for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]]) l.addSubnet(a, p, 'ipv6');
  return l;
})();

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for the control pairs)                       */
/* ------------------------------------------------------------------ */

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9-]{2,63}$/;

/** `https://Host.Example:8443/x`, `host.example.` or `host.example` -> `host.example`; else null. */
function normalizeHost(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null; // error-ok — an unparseable URL is not a host
    }
  } else {
    s = s.split(/[/?#]/)[0].replace(/:\d+$/, '');
  }
  s = s.replace(/\.$/, '');
  if (net.isIP(s)) return null;
  return HOSTNAME_RE.test(s) ? s : null;
}

function registrableDomain(host) {
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const last2 = labels.slice(-2).join('.');
  return TWO_LEVEL_SUFFIXES.has(last2) ? labels.slice(-3).join('.') : last2;
}

/** `www.x` and `x` are one host for "is this on the estate" purposes. */
function estateKey(host) {
  return host.replace(/^www\./, '');
}

function decodeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/** `<loc>` URLs of a sitemap or sitemap index. */
function parseSitemap(xml) {
  const text = String(xml || '');
  const locs = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)\s*(?:\]\]>)?\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(text)) !== null) locs.push(decodeXml(m[1]));
  return { locs, isIndex: /<sitemapindex[\s>]/i.test(text) };
}

function parseRobotsSitemaps(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** `DNS:a, DNS:*.b, IP Address:1.2.3.4` -> { hosts: ['a'], wildcards: ['*.b'] }. */
function parseSubjectAltName(san) {
  const hosts = [];
  const wildcards = [];
  for (const entry of String(san || '').split(/,\s*/)) {
    const m = /^DNS:(.+)$/.exec(entry.trim());
    if (!m) continue;
    const name = m[1].replace(/^"|"$/g, '').toLowerCase();
    if (name.includes('*')) wildcards.push(name);
    else {
      const h = normalizeHost(name);
      if (h) hosts.push(h);
    }
  }
  return { hosts, wildcards };
}

/** Same-site `<a href>` hostnames on a page. */
function extractSameSiteLinkHosts(html, baseUrl) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return []; // error-ok — no usable base, no links to resolve
  }
  const site = registrableDomain(base.hostname.toLowerCase());
  const out = new Set();
  const re = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const href = decodeXml(m[1] ?? m[2] ?? m[3] ?? '');
    let u;
    try {
      u = new URL(href, base);
    } catch {
      continue; // error-ok — a malformed href is not a host
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    const h = normalizeHost(u.hostname);
    if (h && registrableDomain(h) === site) out.add(h);
  }
  return [...out];
}

/** Public-address test used before a discovered host is sent a request. */
function isNonPublicAddress(address, family) {
  return NON_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * `expectedIps` (exact) + `expectedCidrs` (`a.b.c.d/n`, `x::/n`) -> allowlist.
 * A malformed entry is reported in `invalid`, never dropped: a typo that
 * silently disabled the check would be "reports success while checking
 * nothing" (Doctrine #1).
 */
function buildAllowlist(ips, cidrs) {
  const list = new net.BlockList();
  const families = { ipv4: false, ipv6: false };
  const invalid = [];
  const asArray = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(',') : []);
  for (const raw of asArray(ips)) {
    const s = String(raw).trim();
    const fam = net.isIP(s);
    if (!fam) { invalid.push(s); continue; }
    list.addAddress(s, fam === 6 ? 'ipv6' : 'ipv4');
    families[fam === 6 ? 'ipv6' : 'ipv4'] = true;
  }
  for (const raw of asArray(cidrs)) {
    const s = String(raw).trim();
    const m = /^([^/]+)\/(\d{1,3})$/.exec(s);
    const fam = m ? net.isIP(m[1]) : 0;
    const prefix = m ? Number(m[2]) : -1;
    if (!fam || prefix < 0 || prefix > (fam === 6 ? 128 : 32)) { invalid.push(s); continue; }
    list.addSubnet(m[1], prefix, fam === 6 ? 'ipv6' : 'ipv4');
    families[fam === 6 ? 'ipv6' : 'ipv4'] = true;
  }
  return {
    configured: families.ipv4 || families.ipv6,
    invalid,
    /** true/false, or null when the allowlist names nothing of this family (not judged). */
    allows(address, family) {
      const key = family === 6 ? 'ipv6' : 'ipv4';
      return families[key] ? list.check(address, key) : null;
    },
  };
}

function isGatewayResponse(status, headers, bodyBytes) {
  const server = String((headers && headers.server) || '');
  const via = String((headers && headers.via) || '');
  const signals = [];
  if (server && GATEWAY_SERVER_RE.test(server)) signals.push(`Server: ${server}`);
  if (via) signals.push(`Via: ${via}`);
  if (bodyBytes.length < SHORT_BODY_BYTES) signals.push(`short body (${bodyBytes.length} bytes)`);
  if (GATEWAY_BODY_RE.test(bodyBytes.text || '')) signals.push('gateway-style body text');
  return { gateway: signals.length > 0 || status === 502 || status === 504, signals };
}

/* ------------------------------------------------------------------ */
/* Default (network) seams                                             */
/* ------------------------------------------------------------------ */

async function queryAddresses(resolver, host) {
  const out = { addresses: [], errors: {} };
  for (const [family, fn] of [[4, 'resolve4'], [6, 'resolve6']]) {
    try {
      for (const address of await resolver[fn](host)) out.addresses.push({ address, family });
    } catch (err) {
      out.errors[family] = err.code || err.message; // error-ok — recorded and classified by the caller
    }
  }
  return out;
}

const NXDOMAIN_CODES = new Set(['ENOTFOUND', 'ENODATA']);

/**
 * One recursive resolver saying NXDOMAIN is not proof the name is gone: on
 * 2026-09-28 the local ISP resolver answered ENOTFOUND for five live
 * *.tallrig.app hosts that 1.1.1.1 and 8.8.8.8 (and nslookup) resolved to
 * 64.177.13.38. So a negative from the system resolver is only a verdict once
 * an independent resolver agrees; a positive from any resolver wins and the
 * disagreement is recorded. `confirmers: []` opts out (system resolver only,
 * marked unconfirmed).
 */
async function defaultResolve(host, confirmers = DEFAULT_CONFIRM_RESOLVERS) {
  const system = await queryAddresses(new dns.promises.Resolver({ timeout: 4000, tries: 2 }), host);
  const negative = system.addresses.length === 0 && Object.values(system.errors).some((c) => NXDOMAIN_CODES.has(c));
  if (!negative) return system;
  if (confirmers.length === 0) return { ...system, confirm: 'unconfirmed' };
  const codes = [`system ${Object.values(system.errors).join('/')}`];
  let answered = 0;
  for (const server of confirmers) {
    const r = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
    r.setServers([server]);
    const q = await queryAddresses(r, host);
    if (q.addresses.length > 0) {
      return { ...q, note: `system resolver said ${codes[0].replace('system ', '')}, ${server} answered ${q.addresses.map((a) => a.address).join(', ')}` };
    }
    const c = Object.values(q.errors).join('/');
    codes.push(`${server} ${c}`);
    if (NXDOMAIN_CODES.has(q.errors[4])) answered++; // the A query itself must say so — an ENODATA on AAAA after an A timeout agrees with nothing
  }
  return { ...system, confirm: answered > 0 ? 'confirmed' : 'unavailable', checkedBy: codes };
}

/**
 * A `lookup` that answers with the address we already resolved and vetted, so the
 * request cannot be re-pointed by a second DNS answer. Node 20+ passes `all: true`
 * on the autoSelectFamily path and wants an array; the classic shape wants (addr, family).
 */
function pinnedLookup(ip, family) {
  return (_host, opts, cb) => (opts && opts.all ? cb(null, [{ address: ip, family }]) : cb(null, ip, family));
}

function defaultProbe({ host, ip, family, timeoutMs }) {
  return new Promise((resolve) => {
    let tlsInfo = null;
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve({ tls: tlsInfo, ...value });
    };
    const req = https.request({
      method: 'GET',
      host,
      path: '/',
      agent: null, // not `false`: only with no agent does Node call createConnection below
      timeout: timeoutMs,
      // A graded probe, not a weakened client: the certificate is read back and
      // judged below (socket.authorized / getPeerCertificate), so the handshake
      // must complete against a broken peer. Only GET / is sent over it.
      createConnection: () => tls.connect({
        host, port: 443, servername: host, rejectUnauthorized: false, lookup: pinnedLookup(ip, family),
      }),
      headers: { 'User-Agent': 'GateTest/1.0 estate probe (gatetest.io)', Accept: '*/*' },
    }, (res) => {
      const chunks = [];
      let length = 0;
      const finish = () => {
        const buf = Buffer.concat(chunks);
        done({
          status: res.statusCode,
          headers: res.headers,
          body: { length: length, text: buf.toString('utf8') },
        });
      };
      res.on('data', (c) => {
        chunks.push(c);
        length += c.length;
        if (length >= BODY_SNIPPET_BYTES) {
          res.destroy();
          finish();
        }
      });
      res.on('end', finish);
      res.on('error', finish);
    });
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        try {
          const cert = socket.getPeerCertificate();
          if (cert && cert.valid_to) {
            const validTo = new Date(cert.valid_to);
            const mismatch = tls.checkServerIdentity(host, cert);
            tlsInfo = {
              validTo: validTo.toISOString(),
              daysLeft: Math.floor((validTo.getTime() - Date.now()) / 86400000),
              coversHost: !mismatch,
              sans: cert.subjectaltname || '',
              authorized: socket.authorized === true,
              authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
            };
          }
        } catch {
          tlsInfo = null; // error-ok — TLS facts are additive; the HTTP verdict stands without them
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      done({ error: { code: 'ETIMEDOUT', message: `no response within ${timeoutMs} ms` } });
    });
    req.on('error', (err) => done({ error: { code: err.code || 'ERR', message: err.message } }));
    req.end();
  });
}

async function defaultFetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'GateTest/1.0 estate discovery (gatetest.io)' },
    });
    const text = (await res.text()).slice(0, MAX_TEXT_BYTES);
    return { status: res.status, text };
  } catch {
    return null; // error-ok — the caller reports the source as not-checked
  } finally {
    clearTimeout(timer);
  }
}

function defaultTlsSans(host) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: PROBE_TIMEOUT_MS }, () => {
      const cert = socket.getPeerCertificate();
      socket.destroy();
      done({ san: cert && cert.subjectaltname ? cert.subjectaltname : '' });
    });
    socket.on('timeout', () => { socket.destroy(); done({ error: 'timeout' }); });
    socket.on('error', (err) => done({ error: err.code || err.message }));
  });
}

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

class EstateModule extends BaseModule {
  constructor(deps = {}) {
    super('estate', 'Estate — discover sibling hosts (list, sitemap, TLS SAN, links) and give each a verdict: ok, gateway-up-app-dead, dead, unexpected-ip, redirects-off-estate, auth-wall');
    this.resolve = deps.resolve || null;
    this.probe = deps.probe || defaultProbe;
    this.fetchText = deps.fetchText || defaultFetchText;
    this.tlsSans = deps.tlsSans || defaultTlsSans;
  }

  _config(config) {
    const cfg = (typeof config.getModuleConfig === 'function'
      ? config.getModuleConfig('estate')
      : config.modules && config.modules.estate) || {};
    const read = (key) => (typeof config.get === 'function' ? config.get(key) : config[key]);
    const crawl = (typeof config.getModuleConfig === 'function' ? config.getModuleConfig('liveCrawler') : null) || {};
    const url = cfg.url || crawl.url || read('webUrl') || read('targetUrl') || null;
    return { cfg, url };
  }

  _listedHosts(cfg, projectRoot, notes) {
    const out = [];
    const raw = Array.isArray(cfg.hosts) ? cfg.hosts : typeof cfg.hosts === 'string' ? cfg.hosts.split(',') : [];
    for (const item of raw) out.push(String(item));
    if (projectRoot) {
      const file = path.join(projectRoot, 'hosts.txt');
      try {
        if (fs.existsSync(file)) {
          for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const t = line.replace(/#.*$/, '').trim();
            if (t) out.push(t);
          }
        }
      } catch (err) {
        notes.push(`hosts.txt could not be read: ${err.message}`); // error-ok — surfaced as not-checked
      }
    }
    const hosts = [];
    for (const item of out) {
      const h = normalizeHost(item);
      if (h) hosts.push(h);
      else notes.push(`ignored host-list entry "${item}" — not a hostname (wildcards and IP literals cannot be probed)`);
    }
    return hosts;
  }

  async run(result, config) {
    const { cfg, url } = this._config(config);
    const notes = [];
    const notChecked = (slug, message) => result.addCheck(`estate:not-checked:${slug}`, false, {
      severity: 'info',
      notChecked: true,
      message,
    });

    const allow = buildAllowlist(cfg.expectedIps, cfg.expectedCidrs);
    if (allow.invalid.length > 0) {
      result.addCheck('estate:config', false, {
        severity: 'error',
        message: `modules.estate.expectedIps/expectedCidrs has ${allow.invalid.length} malformed entr${allow.invalid.length === 1 ? 'y' : 'ies'}: ${allow.invalid.join(', ')} — the unexpected-ip check would silently cover less than you configured`,
        suggestion: 'Fix the entries: exact IPs in expectedIps, "a.b.c.d/n" in expectedCidrs.',
      });
    }

    // host -> Set(sources)
    const found = new Map();
    const add = (host, source) => {
      if (!found.has(host)) found.set(host, new Set());
      found.get(host).add(source);
    };

    for (const h of this._listedHosts(cfg, config.projectRoot, notes)) add(h, 'list');

    let start = null;
    if (url) {
      try {
        start = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
      } catch {
        notes.push(`target "${url}" is not a URL`); // error-ok — reported below
      }
    }
    const targetHost = start ? normalizeHost(start.hostname) : null;

    if (targetHost) {
      add(targetHost, 'target');
      await this._discoverFromTarget({ start, targetHost, config, add, notChecked });
    }

    for (const n of notes) notChecked('discovery', n);

    if (found.size === 0) {
      this._notChecked(result, url
        ? `estate found no hosts to probe from ${url}`
        : 'no target URL and no host list — set modules.estate.hosts, add a hosts.txt at the project root, pass --hosts a,b, or scan a URL');
      return;
    }

    const all = [...found.keys()].sort((a, b) => (a === targetHost ? -1 : b === targetHost ? 1 : a.localeCompare(b)));
    const maxHosts = Number(cfg.maxHosts) > 0 ? Number(cfg.maxHosts) : DEFAULT_MAX_HOSTS;
    const selected = all.slice(0, maxHosts);
    if (all.length > selected.length) {
      notChecked('host-cap', `${all.length - selected.length} discovered host(s) not probed — over modules.estate.maxHosts (${maxHosts}): ${all.slice(maxHosts).join(', ')}`);
    }

    const estateKeys = new Set(all.map(estateKey));
    const budgetMs = Number(cfg.budgetMs) > 0 ? Number(cfg.budgetMs) : DEFAULT_BUDGET_MS;
    const deadline = Date.now() + budgetMs;
    const allowPrivate = cfg.allowPrivate === true;
    const resolvers = Array.isArray(cfg.resolvers) ? cfg.resolvers.map(String) : DEFAULT_CONFIRM_RESOLVERS;

    const outcomes = await pool(selected, CONCURRENCY, (host) => this._checkHost({
      host, estateKeys, allow, allowPrivate, deadline, budgetMs, resolvers,
    }));

    let ok = 0;
    let skipped = 0;
    for (const o of outcomes) {
      o.sources = [...found.get(o.host)].sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b));
      if (o.verdict === 'ok') ok++;
      if (o.verdict === 'not-checked') {
        skipped++;
        notChecked(`host:${o.host}`, `${o.host}: ${o.message}`);
      } else if (o.verdict !== 'ok') {
        result.addCheck(`estate:${o.verdict}:${o.host}`, false, {
          severity: o.severity,
          message: `${o.host} — ${o.message}. Evidence: ${o.evidence}`,
          suggestion: o.suggestion,
          url: `https://${o.host}/`,
          host: o.host,
          status: o.status || null,
          ip: o.ip || null,
        });
      }
      for (const t of o.tlsFindings || []) {
        result.addCheck(`estate:${t.rule}:${o.host}`, false, {
          severity: t.severity,
          message: `${o.host} — ${t.message}. Evidence: ${o.evidence}`,
          suggestion: t.suggestion,
          url: `https://${o.host}/`,
          host: o.host,
        });
      }
    }

    const perSource = SOURCE_ORDER.map((s) => [s, all.filter((h) => found.get(h).has(s)).length]).filter(([, n]) => n > 0);
    const label = { target: 'target', list: 'list', sitemap: 'sitemap', san: 'SAN', links: 'links' };
    result.addCheck('estate:summary', true, {
      severity: 'info',
      message: `${all.length} hosts discovered (sources: ${perSource.map(([s, n]) => `${label[s]} ${n}`).join(', ')}), ${ok} ok`
        + `${skipped > 0 ? `, ${skipped} not checked` : ''}. Probes: DNS A/AAAA + one https GET / per host, concurrency ${CONCURRENCY}, ${PROBE_TIMEOUT_MS / 1000}s timeout.`,
      details: outcomes.map((o) => ({ host: o.host, verdict: o.verdict, status: o.status || null, ip: o.ip || null, sources: o.sources })),
    });
  }

  async _discoverFromTarget({ start, targetHost, config, add, notChecked }) {
    const origin = `${start.protocol}//${start.host}`;

    // (b) sitemaps
    const queue = [];
    const seen = new Set();
    const enqueue = (u) => { if (!seen.has(u) && seen.size < MAX_SITEMAPS) { seen.add(u); queue.push(u); } };
    enqueue(`${origin}/sitemap.xml`);
    const robots = await this.fetchText(`${origin}/robots.txt`);
    if (robots && robots.status === 200) {
      for (const s of parseRobotsSitemaps(robots.text)) {
        const h = normalizeHost(s);
        if (h) add(h, 'sitemap');
        if (h && estateKey(h) === estateKey(targetHost)) enqueue(s);
      }
    }
    let sitemapsRead = 0;
    while (queue.length > 0) {
      const u = queue.shift();
      const res = await this.fetchText(u);
      if (!res || res.status !== 200) continue;
      sitemapsRead++;
      const { locs, isIndex } = parseSitemap(res.text);
      for (const loc of locs) {
        const h = normalizeHost(loc);
        if (h) add(h, 'sitemap');
        if (isIndex && h && estateKey(h) === estateKey(targetHost)) enqueue(loc);
      }
    }
    if (sitemapsRead === 0) notChecked('sitemap', `no sitemap readable at ${origin}/sitemap.xml or via robots.txt — sitemap discovery contributed no hosts`);

    // (c) TLS SAN
    if (start.protocol === 'https:') {
      const r = await this.tlsSans(targetHost);
      if (!r || r.error) {
        notChecked('san', `TLS certificate of ${targetHost} could not be read (${(r && r.error) || 'no answer'}) — SAN discovery contributed no hosts`);
      } else {
        const { hosts, wildcards } = parseSubjectAltName(r.san);
        for (const h of hosts) add(h, 'san');
        for (const w of wildcards) {
          notChecked('wildcard-san', `certificate carries wildcard SAN ${w} — cannot enumerate; supply a list (modules.estate.hosts, hosts.txt or --hosts)`);
        }
      }
    } else {
      notChecked('san', `target is ${start.protocol.replace(':', '')}, not https — no TLS certificate to read SANs from`);
    }

    // (d) same-site links on the start page
    let html = config.livePage && typeof config.livePage.html === 'string' ? config.livePage.html : null;
    if (html === null) {
      const page = await this.fetchText(start.href);
      html = page && page.status === 200 ? page.text : null;
    }
    if (html === null) notChecked('links', `start page ${start.href} could not be read — link discovery contributed no hosts`);
    else for (const h of extractSameSiteLinkHosts(html, start.href)) add(h, 'links');
  }

  async _checkHost({ host, estateKeys, allow, allowPrivate, deadline, budgetMs, resolvers }) {
    const out = { host, verdict: 'ok', severity: 'info', evidence: '', message: '' };
    if (Date.now() >= deadline) {
      return { ...out, verdict: 'not-checked', message: `not probed — the ${budgetMs / 1000}s estate budget was exhausted first` };
    }

    const dnsRes = await (this.resolve ? this.resolve(host) : defaultResolve(host, resolvers));
    const addresses = (dnsRes && dnsRes.addresses) || [];
    const errs = (dnsRes && dnsRes.errors) || {};
    if (addresses.length === 0) {
      const codes = Object.values(errs);
      const nx = codes.includes('ENOTFOUND');
      const nodata = codes.length > 0 && codes.every((c) => c === 'ENODATA');
      if ((nx || nodata) && dnsRes.confirm === 'unavailable') {
        return { ...out, verdict: 'not-checked', message: `system resolver says ${codes.join('/')} but no independent resolver could confirm (${(dnsRes.checkedBy || []).join('; ')}) — not a verdict` };
      }
      if (nx || nodata) {
        const seen = dnsRes.checkedBy ? dnsRes.checkedBy.join('; ') : codes.join('/') || 'no answer';
        return {
          ...out,
          verdict: 'dead',
          severity: 'error',
          message: `${nx ? 'DNS name does not exist (NXDOMAIN)' : 'DNS name has no A or AAAA record'}${dnsRes.confirm === 'unconfirmed' ? ' — system resolver only, unconfirmed' : ''}`,
          evidence: `resolve A/AAAA ${host} -> ${seen}`,
          suggestion: 'Delete the stale reference to this host, or restore its DNS record and service.',
        };
      }
      return { ...out, verdict: 'not-checked', message: `DNS lookup failed (${codes.join('/') || 'no answer'}) — the host was not probed, this is not a verdict on it` };
    }

    const first = addresses.find((a) => a.family === 4) || addresses[0];
    const ipList = addresses.map((a) => a.address).join(', ');
    out.ip = first.address;

    let outside = null;
    if (allow.configured) {
      outside = addresses.find((a) => allow.allows(a.address, a.family) === false) || null;
    }
    const unexpected = outside
      ? {
        message: `resolves to ${outside.address}, outside the expected addresses (${ipList} resolved)`,
        suggestion: 'Point DNS at an address you control or delete the record — a name that still resolves to an address you no longer control is a takeover and phishing risk.',
      }
      : null;

    if (!allowPrivate && addresses.some((a) => isNonPublicAddress(a.address, a.family))) {
      if (unexpected) {
        return { ...out, verdict: 'unexpected-ip', severity: 'error', ...unexpected, evidence: `resolve A/AAAA ${host} -> ${ipList}` };
      }
      return { ...out, verdict: 'not-checked', message: `resolves to a non-public address (${ipList}) — not probed; set modules.estate.allowPrivate to probe internal hosts` };
    }

    const probe = await this.probe({ host, ip: first.address, family: first.family, timeoutMs: PROBE_TIMEOUT_MS });
    const request = `GET https://${host}/ via ${first.address}`;

    if (probe.error) {
      out.evidence = `${request} -> ${probe.error.code}: ${probe.error.message}`;
      return {
        ...out,
        verdict: 'dead',
        severity: 'error',
        message: `${probe.error.code === 'ECONNREFUSED' ? 'connection refused' : probe.error.code === 'ETIMEDOUT' ? 'no response' : `connection failed (${probe.error.code})`} on 443`,
        suggestion: 'The name resolves but nothing serves it over https. Restore the service or remove the DNS record.',
      };
    }

    const status = probe.status;
    out.status = status;
    const headers = probe.headers || {};
    const body = probe.body || { length: 0, text: '' };
    const bodyLen = headers['content-length'] !== undefined && /^\d+$/.test(String(headers['content-length']))
      ? Number(headers['content-length']) : body.length;
    const seenBits = [`${status}`];
    if (headers.server) seenBits.push(`Server: ${headers.server}`);
    seenBits.push(`${bodyLen} byte body`);
    out.evidence = `${request} -> ${seenBits.join(', ')}${dnsRes.note ? `; DNS: ${dnsRes.note}` : ''}`;
    if (headers.location && status >= 300 && status < 400) out.evidence += `, Location: ${headers.location}`;

    out.tlsFindings = this._tlsFindings(probe.tls);

    const gw = isGatewayResponse(status, headers, { length: bodyLen, text: body.text });
    let verdict = 'ok';
    let severity = 'info';
    let message = '';
    let suggestion = '';

    if (status === 502 || status === 503 || status === 504) {
      verdict = 'gateway-up-app-dead';
      severity = 'error';
      message = `gateway answers ${status} — the proxy is up and the app behind it is not serving (saw ${gw.signals.length ? gw.signals.join('; ') : 'no gateway signature; may be the app\'s own error page'})`;
      suggestion = 'Check the process/container/unit behind this host on the platform, or remove the route if the app is retired.';
    } else if (status === 401 || status === 403) {
      verdict = 'auth-wall';
      severity = 'warning';
      message = `answers ${status} at / — behind an auth wall, so GateTest cannot see its pages`;
      suggestion = 'Expected for private hosts. To test what is behind it, scan that host with a token (--crawl-header "Authorization: ...").';
    } else if (status >= 300 && status < 400) {
      if (headers.location) {
        let target = null;
        try {
          target = normalizeHost(new URL(String(headers.location), `https://${host}/`).hostname);
        } catch {
          target = null; // error-ok — unparseable Location is judged as off-estate below
        }
        if (!target || !estateKeys.has(estateKey(target))) {
          verdict = 'redirects-off-estate';
          severity = 'warning';
          message = `/ redirects to ${target || headers.location}, which is not in the discovered estate`;
          suggestion = 'If the destination is yours, add it to modules.estate.hosts; if not, this host is handing traffic to someone else.';
        }
      }
    } else if (status === 429) {
      return { ...out, verdict: 'not-checked', message: `answered 429 (rate limited) — ${out.evidence}` };
    } else if (status >= 500) {
      verdict = 'http-error';
      severity = 'error';
      message = `answers ${status} at /`;
      suggestion = 'The app is up but failing; check its logs.';
    } else if (status >= 400) {
      verdict = 'http-error';
      severity = 'warning';
      message = `answers ${status} at /`;
      suggestion = 'A host with nothing at / is fine if intended; otherwise route or serve a page there.';
    }

    if (unexpected) {
      const also = verdict !== 'ok' ? `; also ${verdict} (${status})` : `; answers ${status}`;
      return { ...out, verdict: 'unexpected-ip', severity: 'error', message: `${unexpected.message}${also}`, suggestion: unexpected.suggestion };
    }
    return { ...out, verdict, severity, message, suggestion };
  }

  _tlsFindings(t) {
    if (!t) return [];
    const out = [];
    if (t.daysLeft < 0) {
      out.push({ rule: 'tls-expired', severity: 'error', message: `TLS certificate expired ${-t.daysLeft} day(s) ago (${t.validTo})`, suggestion: 'Renew the certificate; check the ACME/renewal job for this host.' });
    } else if (t.daysLeft <= TLS_EXPIRING_DAYS) {
      out.push({ rule: 'tls-expiring', severity: 'warning', message: `TLS certificate expires in ${t.daysLeft} day(s) (${t.validTo})`, suggestion: 'Renew the certificate now; check the ACME/renewal job for this host.' });
    }
    if (!t.coversHost) {
      out.push({ rule: 'tls-san-mismatch', severity: 'warning', message: `TLS certificate does not cover this hostname (SAN: ${t.sans || 'none'})`, suggestion: 'Issue a certificate that lists this host, or route the host to a service that has one.' });
    } else if (!t.authorized && t.authorizationError && t.daysLeft >= 0) {
      out.push({ rule: 'tls-untrusted', severity: 'warning', message: `TLS certificate is not trusted (${t.authorizationError})`, suggestion: 'Serve the full certificate chain from a public CA.' });
    }
    return out;
  }
}

module.exports = EstateModule;
module.exports.normalizeHost = normalizeHost;
module.exports.parseSitemap = parseSitemap;
module.exports.parseRobotsSitemaps = parseRobotsSitemaps;
module.exports.parseSubjectAltName = parseSubjectAltName;
module.exports.extractSameSiteLinkHosts = extractSameSiteLinkHosts;
module.exports.buildAllowlist = buildAllowlist;
module.exports.isNonPublicAddress = isNonPublicAddress;
module.exports.isGatewayResponse = isGatewayResponse;
module.exports.pinnedLookup = pinnedLookup;
module.exports.defaultResolve = defaultResolve;
