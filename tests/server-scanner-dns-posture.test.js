'use strict';

/**
 * Issue #807 R4 — `dnsPosture` / `mailPosture` honesty in `gatetest --server`
 * (`ServerScanner._checkDNS`, src/scanners/server-scanner.js).
 *
 * What the DNS module claimed that was not true:
 *   - "pass: DMARC reference found" when the APEX TXT merely contained the
 *     substring `_dmarc` or `v=DMARC1` — DMARC policy lives only at
 *     `_dmarc.<domain>`; text at the apex is not a policy.
 *   - "pass: DMARC record found" for ANY TXT at `_dmarc.`, `v=DMARC1` or
 *     not, `p=none` (monitoring only) or not.
 *   - "pass: SPF record found" for a record ending `+all`, which authorises
 *     every sender on the internet.
 *   - "warning: No DMARC record" / "info: No TXT records" when the resolver
 *     had TIMED OUT or SERVFAILed — nothing had been proved absent.
 *
 * Every lookup here goes through an injected callback-style resolver, so
 * the tests are deterministic and never touch the network; the code under
 * test is the real `_checkDNS`.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ServerScanner = require('../src/scanners/server-scanner');

/**
 * `answers` maps `"<method> <name>"` to a value (success), an error code
 * string (the resolver failed / said absent that way), or nothing
 * (ENOTFOUND — the record does not exist).
 */
function fakeResolver(answers) {
  const err = (code) => Object.assign(new Error(code), { code });
  const make = (method) => (...args) => {
    const cb = args[args.length - 1];
    const answer = answers[`${method} ${args[0]}`];
    if (answer === undefined) return cb(err('ENOTFOUND'));
    if (typeof answer === 'string') return cb(err(answer));
    return cb(null, answer);
  };
  return {
    resolve4: make('resolve4'),
    resolve6: make('resolve6'),
    resolveMx: make('resolveMx'),
    resolveTxt: make('resolveTxt'),
    lookup: make('lookup'),
  };
}

const HOST = 'example.test';
const HARDENED = {
  [`resolve4 ${HOST}`]: ['203.0.113.10'],
  [`resolveMx ${HOST}`]: [{ exchange: 'mx.example.test', priority: 10 }],
  [`resolveTxt ${HOST}`]: [['v=spf1 include:_spf.example.net -all']],
  [`resolveTxt _dmarc.${HOST}`]: [['v=DMARC1; p=reject; rua=mailto:dmarc@example.test']],
};

async function dnsDetails(answers, host = HOST) {
  const scanner = new ServerScanner();
  const mod = await scanner._checkDNS(host, fakeResolver(answers));
  return { mod, details: mod.details, sev: ServerScanner.countSeverities({ modules: [mod] }) };
}

describe('server DNS posture — control: a hardened domain passes cleanly', () => {
  it('SPF -all and DMARC p=reject are passes with the qualifier named; zero warnings, zero errors', async () => {
    const { details, sev } = await dnsDetails(HARDENED);
    assert.deepEqual(sev, { errors: 0, warnings: 0 }, JSON.stringify(details));
    assert.ok(details.includes('pass: SPF record found (-all)'), JSON.stringify(details));
    assert.ok(details.includes('pass: DMARC record found (p=reject)'), JSON.stringify(details));
    assert.ok(details.includes('pass: 1 MX record(s) found'));
    assert.ok(details.some((d) => d.startsWith('pass: 1 A record(s)')));
  });

  it('CONTROL — a genuine ENOTFOUND at _dmarc and an empty apex TXT set still warn (a real absence is still a finding)', async () => {
    const { details, sev } = await dnsDetails({ [`resolve4 ${HOST}`]: ['203.0.113.10'] });
    assert.ok(details.includes('warning: No DMARC record — email authentication not configured'), JSON.stringify(details));
    assert.ok(details.includes('warning: No SPF record — email spoofing risk'), JSON.stringify(details));
    assert.equal(sev.warnings, 2);
    assert.equal(sev.errors, 0);
  });
});

describe('server DNS posture — a resolver failure is NOT CHECKED, never "no record" (issue #807)', () => {
  it('ETIMEOUT / ESERVFAIL on the TXT lookups reads NOT CHECKED with the code and raises no warning', async () => {
    const { details, sev } = await dnsDetails({
      [`resolve4 ${HOST}`]: ['203.0.113.10'],
      [`resolveTxt ${HOST}`]: 'ESERVFAIL',
      [`resolveTxt _dmarc.${HOST}`]: 'ETIMEOUT',
      [`resolveMx ${HOST}`]: 'ETIMEOUT',
    });
    assert.ok(!details.some((d) => /No DMARC record/.test(d)), `must not claim absence: ${JSON.stringify(details)}`);
    assert.ok(!details.some((d) => /No SPF record/.test(d)), `must not claim absence: ${JSON.stringify(details)}`);
    assert.ok(details.some((d) => d.startsWith('info: NOT CHECKED — DMARC:') && d.includes('ETIMEOUT')), JSON.stringify(details));
    assert.ok(details.some((d) => d.startsWith('info: NOT CHECKED — SPF:') && d.includes('ESERVFAIL')), JSON.stringify(details));
    assert.ok(details.some((d) => d.startsWith('info: NOT CHECKED — MX lookup failed') && d.includes('ETIMEOUT')), JSON.stringify(details));
    assert.deepEqual(sev, { errors: 0, warnings: 0 });
  });

  it('an A lookup that fails at the resolver (and the OS fallback too) is NOT CHECKED, not "does not resolve"', async () => {
    const { details, sev } = await dnsDetails({
      [`resolve4 ${HOST}`]: 'ETIMEOUT',
      [`lookup ${HOST}`]: 'EAI_AGAIN',
      ...Object.fromEntries(Object.entries(HARDENED).filter(([k]) => !k.startsWith('resolve4'))),
    });
    assert.ok(!details.includes('error: Hostname does not resolve'), JSON.stringify(details));
    assert.ok(details.some((d) => d.startsWith('info: NOT CHECKED — A lookup failed at the resolver')), JSON.stringify(details));
    assert.equal(sev.errors, 0);
  });

  it('CONTROL — ENOTFOUND from both the resolver and the OS lookup is still "Hostname does not resolve" (error)', async () => {
    const { details, sev } = await dnsDetails({});
    assert.ok(details.includes('error: Hostname does not resolve'), JSON.stringify(details));
    assert.equal(sev.errors, 1);
  });

  it('an IP literal is NOT CHECKED for every record type — A/MX/SPF/DMARC apply to names', async () => {
    const scanner = new ServerScanner();
    const mod = await scanner._checkDNS('127.0.0.1'); // real dns module, never called
    assert.equal(mod.details.length, 1);
    assert.match(mod.details[0], /^info: NOT CHECKED — 127\.0\.0\.1 is an IP literal/);
    assert.deepEqual(ServerScanner.countSeverities({ modules: [mod] }), { errors: 0, warnings: 0 });
  });
});

describe('server DNS posture — the DMARC claims that were false', () => {
  it('the apex TXT mentioning _dmarc / v=DMARC1 is no longer "DMARC reference found"', async () => {
    const { details } = await dnsDetails({
      ...HARDENED,
      [`resolveTxt ${HOST}`]: [['v=spf1 -all'], ['some-verification=_dmarc v=DMARC1 lookalike']],
      [`resolveTxt _dmarc.${HOST}`]: undefined,
    });
    assert.ok(!details.some((d) => /DMARC reference/.test(d)), JSON.stringify(details));
    assert.ok(details.includes('warning: No DMARC record — email authentication not configured'), JSON.stringify(details));
  });

  it('a TXT at _dmarc that is not a v=DMARC1 record is a warning, not "DMARC record found"', async () => {
    const { details, sev } = await dnsDetails({ ...HARDENED, [`resolveTxt _dmarc.${HOST}`]: [['google-site-verification=abc']] });
    assert.ok(!details.some((d) => d.startsWith('pass: DMARC')), JSON.stringify(details));
    assert.ok(details.some((d) => d.startsWith('warning: TXT present at _dmarc but none is a DMARC record')), JSON.stringify(details));
    assert.equal(sev.warnings, 1);
  });

  it('DMARC p=none is monitoring only and warns; p=quarantine passes', async () => {
    const none = await dnsDetails({ ...HARDENED, [`resolveTxt _dmarc.${HOST}`]: [['v=DMARC1; p=none; rua=mailto:x@example.test']] });
    assert.ok(none.details.includes('warning: DMARC p=none — monitoring only, spoofed mail is still delivered'), JSON.stringify(none.details));
    const quarantine = await dnsDetails({ ...HARDENED, [`resolveTxt _dmarc.${HOST}`]: [['v=DMARC1;p=quarantine']] });
    assert.ok(quarantine.details.includes('pass: DMARC record found (p=quarantine)'), JSON.stringify(quarantine.details));
    assert.equal(quarantine.sev.warnings, 0);
  });

  it('a v=DMARC1 record with no valid p= is a warning', async () => {
    const { details } = await dnsDetails({ ...HARDENED, [`resolveTxt _dmarc.${HOST}`]: [['v=DMARC1; rua=mailto:x@example.test']] });
    assert.ok(details.includes('warning: DMARC record has no valid p= policy — receivers ignore it'), JSON.stringify(details));
  });
});

describe('server DNS posture — the SPF claims that were false', () => {
  it('SPF ending +all (or bare all) authorises every sender and warns instead of passing', async () => {
    const plus = await dnsDetails({ ...HARDENED, [`resolveTxt ${HOST}`]: [['v=spf1 include:_spf.example.net +all']] });
    assert.ok(plus.details.includes('warning: SPF record ends in +all — authorises every sender, spoofing not prevented'), JSON.stringify(plus.details));
    assert.ok(!plus.details.some((d) => d.startsWith('pass: SPF')));
    const neutral = await dnsDetails({ ...HARDENED, [`resolveTxt ${HOST}`]: [['v=spf1 ip4:203.0.113.0/24 ?all']] });
    assert.ok(neutral.details.some((d) => d.startsWith('warning: SPF record ends in ?all')), JSON.stringify(neutral.details));
  });

  it('SPF with no all mechanism and no redirect warns; redirect= passes', async () => {
    const noAll = await dnsDetails({ ...HARDENED, [`resolveTxt ${HOST}`]: [['v=spf1 include:_spf.example.net']] });
    assert.ok(noAll.details.some((d) => d.startsWith('warning: SPF record has no "all" mechanism')), JSON.stringify(noAll.details));
    const redirect = await dnsDetails({ ...HARDENED, [`resolveTxt ${HOST}`]: [['v=spf1 redirect=_spf.example.net']] });
    assert.ok(redirect.details.includes('pass: SPF record found (redirect=_spf.example.net)'), JSON.stringify(redirect.details));
  });

  it('two SPF records are a permanent error at receivers and warn', async () => {
    const { details } = await dnsDetails({ ...HARDENED, [`resolveTxt ${HOST}`]: [['v=spf1 -all'], ['v=spf1 include:a.example -all']] });
    assert.ok(details.some((d) => d.startsWith('warning: 2 SPF records')), JSON.stringify(details));
  });

  it('CONTROL — ~all (softfail) is still a pass; a multi-string TXT is joined before parsing', async () => {
    const { details, sev } = await dnsDetails({ ...HARDENED, [`resolveTxt ${HOST}`]: [['v=spf1 include:_spf.exam', 'ple.net ~all']] });
    assert.ok(details.includes('pass: SPF record found (~all)'), JSON.stringify(details));
    assert.equal(sev.warnings, 0);
  });
});
