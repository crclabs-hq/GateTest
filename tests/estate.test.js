'use strict';

/**
 * estate module (R3 of epic #807) — `gatetest --crawl https://tallrig.com`
 * printed PASSED while alecrae.tallrig.app answered 503 and four more
 * *.tallrig.app hosts answered 502, because a crawl never leaves the apex.
 *
 * Control pairs (Doctrine #3): each verdict has the input that must fire it
 * and the neighbouring input that must stay quiet. Network is stubbed through
 * the module's own seams (resolve / probe / fetchText / tlsSans), the way the
 * web-scan tests inject fetch.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const EstateModule = require('../src/modules/estate');
const {
  normalizeHost, parseSitemap, parseRobotsSitemaps, parseSubjectAltName,
  extractSameSiteLinkHosts, buildAllowlist, isNonPublicAddress, pinnedLookup,
} = EstateModule;

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); },
  };
}

const ok200 = { status: 200, headers: { server: 'Traefik', 'content-length': '5000' }, body: { length: 4096, text: '<html>' } };

/** Build a module whose network is a table: host -> { ip, probe, dnsError }. */
function fixture({ hosts = {}, sitemap = null, robots = null, page = '<html></html>', san = 'DNS:app.example.com', probeLog = null } = {}) {
  let inFlight = 0;
  let maxInFlight = 0;
  const probes = [];
  const mod = new EstateModule({
    resolve: async (host) => {
      const h = hosts[host];
      if (!h) return { addresses: [], errors: { 4: 'ENOTFOUND', 6: 'ENOTFOUND' } };
      if (h.dnsError) return { addresses: [], errors: { 4: h.dnsError, 6: h.dnsError } };
      return { addresses: [{ address: h.ip || '203.0.113.7', family: 4 }], errors: {} };
    },
    probe: async ({ host, ip }) => {
      probes.push(host);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const h = hosts[host] || {};
      if (probeLog) probeLog.push({ host, ip });
      return h.probe || ok200;
    },
    fetchText: async (url) => {
      if (url.endsWith('/sitemap.xml')) return sitemap === null ? { status: 404, text: '' } : { status: 200, text: sitemap };
      if (url.endsWith('/robots.txt')) return robots === null ? { status: 404, text: '' } : { status: 200, text: robots };
      return { status: 200, text: page };
    },
    tlsSans: async () => ({ san }),
  });
  return { mod, probes, maxInFlight: () => maxInFlight };
}

const cfg = (estate = {}, extra = {}) => ({ modules: { estate }, targetUrl: 'https://app.example.com/', ...extra });
const finding = (result, verdict, host) => result.checks.find((c) => c.name === `estate:${verdict}:${host}`);
const failing = (result) => result.checks.filter((c) => !c.passed && !c.notChecked);
const summary = (result) => result.checks.find((c) => c.name === 'estate:summary');

describe('estate — host discovery (deterministic, de-duplicated, sources reported)', () => {
  it('unions list + sitemap + SAN + links, one entry per host, and says where each came from', async () => {
    const hosts = {};
    for (const h of ['app.example.com', 'a.example.com', 'b.example.com', 'c.example.com', 'd.example.com', 'e.example.com']) hosts[h] = {};
    const { mod } = fixture({
      hosts,
      // b is in the list AND the sitemap; c is in the sitemap AND the SAN.
      sitemap: '<urlset><url><loc>https://b.example.com/x</loc></url><url><loc>https://c.example.com/</loc></url><url><loc>https://app.example.com/p</loc></url></urlset>',
      robots: 'User-agent: *\nSitemap: https://app.example.com/sitemap.xml\n',
      san: 'DNS:app.example.com, DNS:c.example.com, DNS:d.example.com',
      page: '<a href="https://e.example.com/">e</a><a href="/local">l</a><a href="https://elsewhere.org/">off-site</a>',
    });
    const result = makeResult();
    await mod.run(result, cfg({ hosts: ['a.example.com', 'B.example.com.'] }));
    const s = summary(result);
    const seen = s.details.map((d) => d.host);
    assert.deepEqual([...seen].sort(), ['a.example.com', 'app.example.com', 'b.example.com', 'c.example.com', 'd.example.com', 'e.example.com']);
    assert.equal(new Set(seen).size, seen.length, 'no host listed twice');
    assert.match(s.message, /^6 hosts discovered \(sources: target 1, list 2, sitemap 3, SAN 3, links 2\), 6 ok/);
    assert.deepEqual(s.details.find((d) => d.host === 'b.example.com').sources, ['list', 'sitemap']);
    assert.ok(!seen.includes('elsewhere.org'), 'off-site link is not estate');
    assert.equal(failing(result).length, 0);
  });

  it('a wildcard SAN is reported as "cannot enumerate; supply a list" and never becomes a host', async () => {
    const { mod } = fixture({ hosts: { 'app.example.com': {} }, san: 'DNS:app.example.com, DNS:*.example.com' });
    const result = makeResult();
    await mod.run(result, cfg());
    const note = result.checks.find((c) => c.name === 'estate:not-checked:wildcard-san');
    assert.ok(note, 'wildcard note present');
    assert.equal(note.notChecked, true);
    assert.match(note.message, /\*\.example\.com.*cannot enumerate; supply a list/);
    assert.deepEqual(summary(result).details.map((d) => d.host), ['app.example.com']);
    assert.ok(!result.checks.some((c) => c.name.includes('*')), 'no false host from the wildcard');
  });

  it('follows a sitemap index (same-host children only) and reads robots.txt Sitemap lines', async () => {
    const fetched = [];
    const mod = new EstateModule({
      resolve: async () => ({ addresses: [{ address: '203.0.113.7', family: 4 }], errors: {} }),
      probe: async () => ok200,
      tlsSans: async () => ({ san: 'DNS:app.example.com' }),
      fetchText: async (url) => {
        fetched.push(url);
        if (url.endsWith('/robots.txt')) return { status: 200, text: 'Sitemap: https://app.example.com/index.xml\nSitemap: https://other.example.net/never-fetched.xml' };
        if (url.endsWith('/index.xml')) return { status: 200, text: '<sitemapindex><sitemap><loc>https://app.example.com/child.xml</loc></sitemap></sitemapindex>' };
        if (url.endsWith('/child.xml')) return { status: 200, text: '<urlset><url><loc>https://deep.example.com/</loc></url></urlset>' };
        return { status: 404, text: '' };
      },
    });
    const result = makeResult();
    await mod.run(result, cfg());
    assert.ok(summary(result).details.some((d) => d.host === 'deep.example.com'), 'host found two sitemap levels down');
    assert.ok(!fetched.some((u) => u.includes('other.example.net')), 'a foreign-host sitemap is never fetched');
  });

  it('says so when no sitemap is readable — three-state, not silence', async () => {
    const { mod } = fixture({ hosts: { 'app.example.com': {} }, sitemap: null });
    const result = makeResult();
    await mod.run(result, cfg());
    assert.ok(result.checks.some((c) => c.name === 'estate:not-checked:sitemap' && c.notChecked));
  });

  it('with neither a URL nor a host list it is not-checked, never a pass', async () => {
    const { mod } = fixture();
    const result = makeResult();
    await mod.run(result, { modules: { estate: {} }, projectRoot: '' });
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0].name, 'estate:not-checked');
    assert.equal(result.checks[0].passed, false);
    assert.equal(result.checks[0].notChecked, true);
  });

  it('a host list alone (no URL) is enough to run', async () => {
    const { mod, probes } = fixture({ hosts: { 'x.example.org': {} } });
    const result = makeResult();
    await mod.run(result, { modules: { estate: { hosts: 'x.example.org' } } });
    assert.deepEqual(probes, ['x.example.org']);
    assert.match(summary(result).message, /^1 hosts discovered \(sources: list 1\), 1 ok/);
  });
});

describe('estate — verdicts (each fires on its input and stays quiet next to it)', () => {
  const alecrae = 'alecrae.tallrig.app';

  it('502 from Traefik -> gateway-up-app-dead, error, evidence names status, IP, probe and what was seen', async () => {
    const { mod } = fixture({ hosts: {
      'app.example.com': {},
      [alecrae]: { ip: '198.51.100.9', probe: { status: 502, headers: { server: 'Traefik', 'content-length': '11' }, body: { length: 11, text: 'Bad Gateway' } } },
    } });
    const result = makeResult();
    await mod.run(result, cfg({ hosts: [alecrae] }));
    const f = finding(result, 'gateway-up-app-dead', alecrae);
    assert.ok(f, 'finding present');
    assert.equal(f.severity, 'error');
    assert.equal(f.passed, false);
    assert.equal(f.status, 502);
    assert.equal(f.ip, '198.51.100.9');
    assert.match(f.message, /Evidence: GET https:\/\/alecrae\.tallrig\.app\/ via 198\.51\.100\.9 -> 502, Server: Traefik, 11 byte body/);
    assert.match(f.message, /Server: Traefik; short body \(11 bytes\); gateway-style body text/);
    assert.equal(failing(result).length, 1, 'only the dead host is a finding');
  });

  it('a 503 with no gateway signature says so instead of overclaiming', async () => {
    const { mod } = fixture({ hosts: { 'app.example.com': {}, 'm.example.com': { probe: { status: 503, headers: {}, body: { length: 4096, text: 'x'.repeat(4096) } } } } });
    const result = makeResult();
    await mod.run(result, cfg({ hosts: ['m.example.com'] }));
    const f = finding(result, 'gateway-up-app-dead', 'm.example.com');
    assert.equal(f.severity, 'error');
    assert.match(f.message, /no gateway signature; may be the app's own error page/);
  });

  it('NXDOMAIN -> dead (error); a DNS SERVFAIL is NOT a verdict, it is not-checked', async () => {
    const { mod } = fixture({ hosts: { 'app.example.com': {}, 'flaky.example.com': { dnsError: 'ESERVFAIL' } } });
    const result = makeResult();
    await mod.run(result, cfg({ hosts: ['gone.example.com', 'flaky.example.com'] }));
    const dead = finding(result, 'dead', 'gone.example.com');
    assert.ok(dead);
    assert.equal(dead.severity, 'error');
    assert.match(dead.message, /NXDOMAIN/);
    assert.match(dead.message, /Evidence: resolve A\/AAAA gone\.example\.com -> ENOTFOUND/);
    assert.equal(finding(result, 'dead', 'flaky.example.com'), undefined);
    const nc = result.checks.find((c) => c.name === 'estate:not-checked:host:flaky.example.com');
    assert.ok(nc && nc.notChecked);
    assert.match(nc.message, /ESERVFAIL/);
  });

  it('connection refused on 443 -> dead (error)', async () => {
    const { mod } = fixture({ hosts: { 'app.example.com': {}, 'r.example.com': { probe: { error: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } } } } });
    const result = makeResult();
    await mod.run(result, cfg({ hosts: ['r.example.com'] }));
    const f = finding(result, 'dead', 'r.example.com');
    assert.equal(f.severity, 'error');
    assert.match(f.message, /connection refused/);
  });

  it('200 -> ok, no finding, counted in the summary', async () => {
    const { mod } = fixture({ hosts: { 'app.example.com': {}, 'fine.example.com': {} } });
    const result = makeResult();
    await mod.run(result, cfg({ hosts: ['fine.example.com'] }));
    assert.equal(failing(result).length, 0);
    assert.match(summary(result).message, /2 hosts discovered .*, 2 ok/);
  });

  it('allowlist 10.0.0.0/8 + a host resolving to 149.28.119.158 -> unexpected-ip (error), even though it answers 200', async () => {
    const { mod } = fixture({ hosts: { 'app.example.com': { ip: '10.1.2.3' }, 'api.vapron.example': { ip: '149.28.119.158' } } });
    const result = makeResult();
    await mod.run(result, cfg({ hosts: ['api.vapron.example'], expectedCidrs: ['10.0.0.0/8'], allowPrivate: true }));
    const f = finding(result, 'unexpected-ip', 'api.vapron.example');
    assert.ok(f);
    assert.equal(f.severity, 'error');
    assert.equal(f.ip, '149.28.119.158');
    assert.match(f.message, /resolves to 149\.28\.119\.158, outside the expected addresses/);
    assert.match(f.message, /answers 200/);
    assert.equal(finding(result, 'unexpected-ip', 'app.example.com'), undefined, 'the host inside 10/8 is fine');
  });

  it('the same host INSIDE the allowlist -> no finding (control)', async () => {
    const { mod } = fixture({ hosts: { 'app.example.com': {}, 'api.vapron.example': { ip: '149.28.119.158' } } });
    const result = makeResult();
    await mod.run(result, cfg({ hosts: ['api.vapron.example'], expectedCidrs: ['149.28.119.0/24'], expectedIps: ['203.0.113.7'] }));
    assert.equal(failing(result).length, 0);
    assert.match(summary(result).message, /2 ok/);
  });

  it('an allowlist that names only IPv4 does not judge an IPv6 answer', () => {
    const a = buildAllowlist([], ['10.0.0.0/8']);
    assert.equal(a.allows('10.2.3.4', 4), true);
    assert.equal(a.allows('149.28.119.158', 4), false);
    assert.equal(a.allows('2001:db8::1', 6), null);
  });

  it('a malformed allowlist entry is an error, not a silently weaker check', async () => {
    const { mod } = fixture({ hosts: { 'app.example.com': {} } });
    const result = makeResult();
    await mod.run(result, cfg({ expectedCidrs: ['10.0.0.0/33', 'not-an-ip'], expectedIps: ['203.0.113.7'] }));
    const c = result.checks.find((x) => x.name === 'estate:config');
    assert.ok(c);
    assert.equal(c.severity, 'error');
    assert.match(c.message, /10\.0\.0\.0\/33, not-an-ip/);
  });

  it('401/403 -> auth-wall (warning)', async () => {
    const { mod } = fixture({ hosts: { 'app.example.com': {}, 'admin.example.com': { probe: { status: 403, headers: {}, body: { length: 9, text: 'Forbidden' } } } } });
    const result = makeResult();
    await mod.run(result, cfg({ hosts: ['admin.example.com'] }));
    const f = finding(result, 'auth-wall', 'admin.example.com');
    assert.equal(f.severity, 'warning');
  });

  it('/ redirecting off the estate -> warning; to www or a discovered host -> quiet', async () => {
    const redirect = (loc) => ({ status: 301, headers: { location: loc }, body: { length: 0, text: '' } });
    const { mod } = fixture({ hosts: {
      'app.example.com': { probe: redirect('https://www.app.example.com/') },
      'old.example.com': { probe: redirect('https://parked.registrar.net/x') },
      'a.example.com': { probe: redirect('https://b.example.com/') },
      'b.example.com': {},
    } });
    const result = makeResult();
    await mod.run(result, cfg({ hosts: ['old.example.com', 'a.example.com', 'b.example.com'] }));
    const f = finding(result, 'redirects-off-estate', 'old.example.com');
    assert.ok(f);
    assert.equal(f.severity, 'warning');
    assert.match(f.message, /parked\.registrar\.net/);
    assert.equal(finding(result, 'redirects-off-estate', 'app.example.com'), undefined, 'apex -> www is the same host');
    assert.equal(finding(result, 'redirects-off-estate', 'a.example.com'), undefined, 'redirect inside the discovered set');
  });

  it('a non-public address is not probed unless allowPrivate is set (SSRF guard) and says so', async () => {
    const probeLog = [];
    const { mod } = fixture({ hosts: { 'app.example.com': {}, 'internal.example.com': { ip: '10.0.0.5' } }, probeLog });
    const result = makeResult();
    await mod.run(result, cfg({ hosts: ['internal.example.com'] }));
    assert.deepEqual(probeLog.map((p) => p.host), ['app.example.com']);
    const nc = result.checks.find((c) => c.name === 'estate:not-checked:host:internal.example.com');
    assert.ok(nc && /non-public address/.test(nc.message));
    assert.equal(isNonPublicAddress('169.254.169.254', 4), true);
    assert.equal(isNonPublicAddress('149.28.119.158', 4), false);
  });

  it('expired and mismatched certificates are reported per host', async () => {
    const expired = { ...ok200, tls: { validTo: '2020-01-01T00:00:00.000Z', daysLeft: -100, coversHost: true, sans: 'DNS:t.example.com', authorized: false, authorizationError: 'CERT_HAS_EXPIRED' } };
    const wrong = { ...ok200, tls: { validTo: '2099-01-01T00:00:00.000Z', daysLeft: 9000, coversHost: false, sans: 'DNS:other.example.com', authorized: false, authorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID' } };
    const { mod } = fixture({ hosts: { 'app.example.com': {}, 't.example.com': { probe: expired }, 'w.example.com': { probe: wrong } } });
    const result = makeResult();
    await mod.run(result, cfg({ hosts: ['t.example.com', 'w.example.com'] }));
    assert.equal(finding(result, 'tls-expired', 't.example.com').severity, 'error');
    assert.equal(finding(result, 'tls-san-mismatch', 'w.example.com').severity, 'warning');
    assert.equal(finding(result, 'tls-expired', 'w.example.com'), undefined);
  });
});

describe('estate — one resolver saying NXDOMAIN is not a verdict (2026-09-28: the ISP resolver called five live hosts dead)', () => {
  const dns = require('node:dns');
  const RealResolver = dns.promises.Resolver;
  /** behaviour: server ('system' or an IP) -> { A: [ips] | code } */
  function withResolvers(behaviour, fn) {
    dns.promises.Resolver = class {
      setServers(list) { this.server = list[0]; }
      async resolve4() {
        const b = behaviour[this.server || 'system'];
        if (Array.isArray(b)) return b;
        throw Object.assign(new Error(String(b)), { code: b });
      }
      async resolve6() { throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' }); }
    };
    return fn().finally(() => { dns.promises.Resolver = RealResolver; });
  }
  const run = async (behaviour, estate = {}) => {
    const { mod } = fixture({ hosts: { 'app.example.com': {}, 'alecrae.example.com': {} } });
    const bare = new EstateModule({ probe: async () => ok200, fetchText: async () => ({ status: 404, text: '' }), tlsSans: async () => ({ san: 'DNS:app.example.com' }) });
    void mod;
    const result = makeResult();
    await withResolvers({ system: ['203.0.113.7'], ...behaviour }, () => bare.run(result, cfg({ hosts: ['alecrae.example.com'], ...estate })));
    return result;
  };

  it('system NXDOMAIN + a public resolver that answers -> the host is probed and reported ok, disagreement printed', async () => {
    const probeLog = [];
    const bare = new EstateModule({ probe: async (p) => { probeLog.push(p); return { status: 502, headers: { server: 'Traefik' }, body: { length: 11, text: 'Bad Gateway' } }; }, fetchText: async () => ({ status: 404, text: '' }), tlsSans: async () => ({ san: '' }) });
    const result = makeResult();
    dns.promises.Resolver = class {
      setServers(l) { this.server = l[0]; }
      async resolve4(h) {
        if (h === 'alecrae.example.com' && !this.server) throw Object.assign(new Error('x'), { code: 'ENOTFOUND' });
        return ['64.177.13.38'];
      }
      async resolve6() { throw Object.assign(new Error('x'), { code: 'ENODATA' }); }
    };
    try { await bare.run(result, cfg({ hosts: ['alecrae.example.com'] })); } finally { dns.promises.Resolver = RealResolver; }
    assert.equal(finding(result, 'dead', 'alecrae.example.com'), undefined, 'not dead — it resolves');
    const f = finding(result, 'gateway-up-app-dead', 'alecrae.example.com');
    assert.ok(f, 'the real verdict is reached');
    assert.match(f.message, /DNS: system resolver said ENOTFOUND(?:\/ENODATA)?, 1\.1\.1\.1 answered 64\.177\.13\.38/);
    assert.ok(probeLog.some((p) => p.ip === '64.177.13.38'));
  });

  it('every resolver says NXDOMAIN -> dead, evidence lists who agreed', async () => {
    const result = await run({ system: 'ENOTFOUND', '1.1.1.1': 'ENOTFOUND', '8.8.8.8': 'ENOTFOUND' });
    const f = finding(result, 'dead', 'alecrae.example.com');
    assert.ok(f);
    assert.match(f.message, /Evidence: resolve A\/AAAA alecrae\.example\.com -> system ENOTFOUND\/ENODATA; 1\.1\.1\.1 ENOTFOUND\/ENODATA; 8\.8\.8\.8 ENOTFOUND\/ENODATA/);
  });

  it('system NXDOMAIN and no confirmer could answer -> not-checked, never dead', async () => {
    const result = await run({ system: 'ENOTFOUND', '1.1.1.1': 'ETIMEOUT', '8.8.8.8': 'ETIMEOUT' });
    assert.equal(finding(result, 'dead', 'alecrae.example.com'), undefined);
    const nc = result.checks.find((c) => c.name === 'estate:not-checked:host:alecrae.example.com');
    assert.ok(nc && /no independent resolver could confirm/.test(nc.message));
  });

  it('resolvers: [] keeps everything on the system resolver and marks the verdict unconfirmed', async () => {
    const result = await run({ system: 'ENOTFOUND' }, { resolvers: [] });
    const f = finding(result, 'dead', 'alecrae.example.com');
    assert.ok(f);
    assert.match(f.message, /system resolver only, unconfirmed/);
  });
});

describe('estate — probe discipline', () => {
  it('one probe per host, never more than five in flight', async () => {
    const hosts = { 'app.example.com': {} };
    const list = [];
    for (let i = 0; i < 17; i++) { hosts[`h${i}.example.com`] = {}; list.push(`h${i}.example.com`); }
    const f = fixture({ hosts });
    const result = makeResult();
    await f.mod.run(result, cfg({ hosts: list }));
    assert.equal(f.probes.length, 18);
    assert.equal(new Set(f.probes).size, 18, 'no host probed twice');
    assert.ok(f.maxInFlight() <= 5, `max in flight was ${f.maxInFlight()}`);
    assert.ok(f.maxInFlight() > 1, 'and it is actually concurrent');
  });

  it('hosts over maxHosts are listed as not-checked, not dropped silently', async () => {
    const hosts = { 'app.example.com': {}, 'a.example.com': {}, 'b.example.com': {}, 'c.example.com': {} };
    const f = fixture({ hosts });
    const result = makeResult();
    await f.mod.run(result, cfg({ hosts: ['a.example.com', 'b.example.com', 'c.example.com'], maxHosts: 2 }));
    assert.equal(f.probes.length, 2);
    const cap = result.checks.find((c) => c.name === 'estate:not-checked:host-cap');
    assert.ok(cap && /2 discovered host\(s\) not probed/.test(cap.message));
  });
});

describe('estate — pure helpers', () => {
  it('pinnedLookup answers both lookup call shapes (Node 24 asks with all:true — the first live run died on it)', () => {
    const lookup = pinnedLookup('64.177.13.38', 4);
    let classic; let all;
    lookup('x.example.com', {}, (...a) => { classic = a; });
    lookup('x.example.com', { all: true }, (...a) => { all = a; });
    assert.deepEqual(classic, [null, '64.177.13.38', 4]);
    assert.deepEqual(all, [null, [{ address: '64.177.13.38', family: 4 }]]);
  });

  it('normalizeHost accepts hosts and URLs, rejects wildcards and IP literals', () => {
    assert.equal(normalizeHost('https://Alecrae.Tallrig.app:8443/x'), 'alecrae.tallrig.app');
    assert.equal(normalizeHost('a.example.com.'), 'a.example.com');
    assert.equal(normalizeHost('*.example.com'), null);
    assert.equal(normalizeHost('10.0.0.1'), null);
    assert.equal(normalizeHost('localhost'), null);
  });

  it('parseSubjectAltName splits names and wildcards, ignores IP entries', () => {
    assert.deepEqual(parseSubjectAltName('DNS:a.example.com, DNS:*.b.example.com, IP Address:1.2.3.4'),
      { hosts: ['a.example.com'], wildcards: ['*.b.example.com'] });
  });

  it('parseSitemap / parseRobotsSitemaps', () => {
    assert.deepEqual(parseSitemap('<sitemapindex><sitemap><loc> https://a.example.com/s.xml </loc></sitemap></sitemapindex>'),
      { locs: ['https://a.example.com/s.xml'], isIndex: true });
    assert.deepEqual(parseRobotsSitemaps('User-agent: *\r\nsitemap: https://a.example.com/s.xml\r\n'), ['https://a.example.com/s.xml']);
  });

  it('extractSameSiteLinkHosts keeps same-site (incl. two-level TLD) and drops off-site', () => {
    const html = '<a href="https://api.example.co.uk/">x</a><a href="https://example.com/">y</a><a href=\'mailto:a@b.c\'>m</a>';
    assert.deepEqual(extractSameSiteLinkHosts(html, 'https://www.example.co.uk/'), ['api.example.co.uk']);
  });
});
