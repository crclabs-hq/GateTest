'use strict';

/**
 * SSRF guard — website/app/lib/ssrf-guard.js
 *
 * Covers the hardening added 2026-07-20 to /api/web/scan and /api/wp/scan:
 * previously each had its own hostname-string blocklist with no DNS
 * resolution and no redirect re-validation (a domain the attacker controls
 * can resolve to a private/metadata address — classic DNS-rebinding SSRF).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resolveAndValidateUrl, isPrivateOrReservedIp } = require('../website/app/lib/ssrf-guard.js');

// ---------------------------------------------------------------------------
// isPrivateOrReservedIp
// ---------------------------------------------------------------------------

describe('isPrivateOrReservedIp', () => {
  test('flags loopback', () => {
    assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
    assert.equal(isPrivateOrReservedIp('::1'), true);
  });

  test('flags RFC1918 private ranges', () => {
    assert.equal(isPrivateOrReservedIp('10.0.0.5'), true);
    assert.equal(isPrivateOrReservedIp('172.16.0.1'), true);
    assert.equal(isPrivateOrReservedIp('172.31.255.255'), true);
    assert.equal(isPrivateOrReservedIp('192.168.1.1'), true);
  });

  test('does NOT flag 172.x outside the 16-31 private range', () => {
    assert.equal(isPrivateOrReservedIp('172.15.0.1'), false);
    assert.equal(isPrivateOrReservedIp('172.32.0.1'), false);
  });

  test('flags link-local including the cloud metadata IP', () => {
    assert.equal(isPrivateOrReservedIp('169.254.169.254'), true);
    assert.equal(isPrivateOrReservedIp('169.254.1.1'), true);
  });

  test('flags 0.x', () => {
    assert.equal(isPrivateOrReservedIp('0.0.0.0'), true);
  });

  test('does not flag a real public IP', () => {
    assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);
    assert.equal(isPrivateOrReservedIp('1.1.1.1'), false);
  });

  test('flags IPv6 link-local and unique-local ranges', () => {
    assert.equal(isPrivateOrReservedIp('fe80::1'), true);
    assert.equal(isPrivateOrReservedIp('fc00::1'), true);
    assert.equal(isPrivateOrReservedIp('fd12:3456::1'), true);
  });

  test('flags IPv4-mapped IPv6 addresses pointing at private/metadata IPs', () => {
    assert.equal(isPrivateOrReservedIp('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateOrReservedIp('::ffff:169.254.169.254'), true);
  });

  test('does not flag a real public IPv6 address', () => {
    assert.equal(isPrivateOrReservedIp('2606:4700:4700::1111'), false);
  });

  test('treats empty/non-string input as private (fail closed)', () => {
    assert.equal(isPrivateOrReservedIp(''), true);
    assert.equal(isPrivateOrReservedIp(null), true);
    assert.equal(isPrivateOrReservedIp(undefined), true);
  });
});

// ---------------------------------------------------------------------------
// resolveAndValidateUrl
// ---------------------------------------------------------------------------

function fakeDns(addresses) {
  return { lookup: async () => addresses };
}

function throwingDns(err) {
  return { lookup: async () => { throw err || new Error('ENOTFOUND'); } };
}

describe('resolveAndValidateUrl', () => {
  test('rejects empty input', async () => {
    const r = await resolveAndValidateUrl('');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty');
  });

  test('rejects invalid URL syntax', async () => {
    const r = await resolveAndValidateUrl('http://[not-a-valid-host');
    assert.equal(r.ok, false);
  });

  test('rejects a non-http(s)-scheme input (mangled by the bare-host https:// coercion, rejected via hostname shape rather than the protocol check — same end result)', async () => {
    const r = await resolveAndValidateUrl('ftp://example.com');
    assert.equal(r.ok, false);
  });

  test('rejects file:// URLs', async () => {
    const r = await resolveAndValidateUrl('file:///etc/passwd');
    assert.equal(r.ok, false);
  });

  test('rejects localhost by hostname shape before ever touching DNS', async () => {
    const r = await resolveAndValidateUrl('http://localhost:3000', {
      _dnsAdapter: throwingDns(new Error('should not be called')),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'domain-localhost');
  });

  test('coerces a bare host (no scheme) to https', async () => {
    const r = await resolveAndValidateUrl('example.com', {
      _dnsAdapter: fakeDns([{ address: '93.184.216.34', family: 4 }]),
    });
    assert.equal(r.ok, true);
    assert.equal(r.url.protocol, 'https:');
  });

  test('accepts a hostname that resolves only to public addresses', async () => {
    const r = await resolveAndValidateUrl('https://example.com', {
      _dnsAdapter: fakeDns([{ address: '93.184.216.34', family: 4 }]),
    });
    assert.equal(r.ok, true);
    assert.equal(r.url.hostname, 'example.com');
  });

  test('DNS-rebinding: rejects a public-looking hostname that resolves to a private IP', async () => {
    const r = await resolveAndValidateUrl('https://evil.example.com', {
      _dnsAdapter: fakeDns([{ address: '127.0.0.1', family: 4 }]),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'resolves-to-private-address');
  });

  test('DNS-rebinding: rejects a hostname that resolves to the cloud metadata IP', async () => {
    const r = await resolveAndValidateUrl('https://evil.example.com', {
      _dnsAdapter: fakeDns([{ address: '169.254.169.254', family: 4 }]),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'resolves-to-private-address');
  });

  test('rejects when ANY resolved address is private, even if others are public', async () => {
    const r = await resolveAndValidateUrl('https://multi.example.com', {
      _dnsAdapter: fakeDns([
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'resolves-to-private-address');
  });

  test('rejects when DNS resolution fails', async () => {
    const r = await resolveAndValidateUrl('https://nonexistent.invalid-tld-xyz', {
      _dnsAdapter: throwingDns(),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'dns-resolution-failed');
  });

  test('rejects when DNS resolves to zero addresses', async () => {
    const r = await resolveAndValidateUrl('https://example.com', {
      _dnsAdapter: fakeDns([]),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'dns-resolution-empty');
  });

  test('rejects reserved TLDs (.test, .example, .invalid)', async () => {
    const r = await resolveAndValidateUrl('https://foo.test', {
      _dnsAdapter: fakeDns([{ address: '8.8.8.8', family: 4 }]),
    });
    assert.equal(r.ok, false);
  });
});
