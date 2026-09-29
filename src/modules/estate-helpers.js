'use strict';

/**
 * Pure helpers and network seams for src/modules/estate.js (module 122).
 * Split out so the module file stays under the 500-line per-file ceiling;
 * estate.js re-exports the ones its tests use. No module logic lives here.
 */

const dns = require('dns');
const https = require('https');
const net = require('net');
const tls = require('tls');

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

module.exports = {
  CONCURRENCY,
  PROBE_TIMEOUT_MS,
  DEFAULT_MAX_HOSTS,
  DEFAULT_BUDGET_MS,
  MAX_SITEMAPS,
  MAX_TEXT_BYTES,
  BODY_SNIPPET_BYTES,
  TLS_EXPIRING_DAYS,
  DEFAULT_CONFIRM_RESOLVERS,
  SOURCE_ORDER,
  GATEWAY_SERVER_RE,
  GATEWAY_BODY_RE,
  SHORT_BODY_BYTES,
  TWO_LEVEL_SUFFIXES,
  NON_PUBLIC,
  HOSTNAME_RE,
  normalizeHost,
  registrableDomain,
  estateKey,
  decodeXml,
  parseSitemap,
  parseRobotsSitemaps,
  parseSubjectAltName,
  extractSameSiteLinkHosts,
  isNonPublicAddress,
  buildAllowlist,
  isGatewayResponse,
  queryAddresses,
  NXDOMAIN_CODES,
  defaultResolve,
  pinnedLookup,
  defaultProbe,
  defaultFetchText,
  defaultTlsSans,
  pool,
};
