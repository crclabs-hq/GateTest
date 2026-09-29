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
 * Not in CRAWL_CAPABLE_MODULES (#802/#814) on purpose: that set mirrors the hosted
 * /web suite, and estate probes many hosts, which the hosted 50 s budget cannot
 * afford. `--crawl <url> --module estate` therefore lists estate as not
 * crawl-capable; run it as `--module estate` with `modules.estate.url` instead.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');
const {
  CONCURRENCY,
  PROBE_TIMEOUT_MS,
  DEFAULT_MAX_HOSTS,
  DEFAULT_BUDGET_MS,
  MAX_SITEMAPS,
  TLS_EXPIRING_DAYS,
  DEFAULT_CONFIRM_RESOLVERS,
  SOURCE_ORDER,
  normalizeHost,
  estateKey,
  parseSitemap,
  parseRobotsSitemaps,
  parseSubjectAltName,
  extractSameSiteLinkHosts,
  isNonPublicAddress,
  buildAllowlist,
  isGatewayResponse,
  defaultResolve,
  pinnedLookup,
  defaultProbe,
  defaultFetchText,
  defaultTlsSans,
  pool,
} = require('./estate-helpers');

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
