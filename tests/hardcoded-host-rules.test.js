'use strict';

// Control pairs for src/core/hardcoded-host-rules.js. Firing halves
// paraphrase Tallrig's shipped shapes (TALLRIG-2026-006 / -011; the corpus is
// private and never committed here); quiet halves are the fixes and the
// third-party hosts a tenant URL legitimately names.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scanHardcodedHosts } = require('../src/core/hardcoded-host-rules');

const rules = (src) => scanHardcodedHosts('src/dns/connect-domain.ts', src).map((f) => f.rule);

describe('hardcoded-dns-target', () => {
  it('fires: an MX record whose target is a host constant', () => {
    assert.deepEqual(rules([
      'export const MAIL_MX = "mx1.mailvendor.example";',
      'generated.push({ name: "@", type: "MX", content: MAIL_MX, ttl: 3600, priority: 10 });',
    ].join('\n')), ['hardcoded-dns-target']);
  });
  it('fires: a CNAME whose target is a host literal', () => {
    assert.deepEqual(rules('records.push({ name: "bounce", type: "CNAME", content: "bounce.mailvendor.io", ttl: 3600 });'), ['hardcoded-dns-target']);
  });
  it('quiet: the target read from the platform identity (the Tallrig fix)', () => {
    assert.deepEqual(rules('generated.push({ name: "@", type: "MX", content: identity.mxHost, ttl: 3600, priority: 10 });'), []);
  });
  it('quiet: an A record carrying the caller\'s IP, and a TXT record', () => {
    assert.deepEqual(rules([
      'generated.push({ name: "@", type: "A", content: hostingIp, ttl: 300 });',
      'generated.push({ name: "@", type: "TXT", content: "v=spf1 -all", ttl: 300 });',
    ].join('\n')), []);
  });
  it('quiet: a commented-out record', () => {
    assert.deepEqual(rules('// { type: "MX", content: "mx1.old.example" },'), []);
  });
});

describe('hardcoded-tenant-domain', () => {
  const tenant = (src) => scanHardcodedHosts('src/deployer.ts', src).map((f) => f.rule);
  it('fires: a tenant host on a base domain typed inline', () => {
    assert.deepEqual(tenant('const subFqdn = `${req.subdomain}.oldbrand.ai`;'), ['hardcoded-tenant-domain']);
    assert.deepEqual(tenant('deployUrl: `https://${input.slug}.oldbrand.app`,'), ['hardcoded-tenant-domain']);
  });
  it('quiet: the host built by a config helper (the Tallrig fix)', () => {
    assert.deepEqual(tenant('deployUrl: `https://${input.slug}.${platformDeployDomain(process.env.PUBLIC_BRAND)}`,'), []);
  });
  it('quiet: a third party\'s host and a variable that is not a tenant', () => {
    assert.deepEqual(tenant([
      'const url = `https://${bucket}.s3.amazonaws.com/${key}`;',
      'const site = `https://${project}.vercel.app`;',
      'const api = `${region}.api.example.org`;',
      'const file = `${name}.config.json`;',
    ].join('\n')), []);
  });
});
