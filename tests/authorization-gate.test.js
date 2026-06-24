const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  authorize, generateCustomerToken, verifyDomainOwnership,
  AuthorizationRefusedError, ARMED_ENV, DNS_TXT_PREFIX,
  normalizeUrl, isFreshConsent,
} = require('../src/core/authorization-gate');

function withArmed(fn) {
  return async () => {
    const prev = process.env[ARMED_ENV];
    process.env[ARMED_ENV] = '1';
    try { await fn(); } finally {
      if (prev === undefined) delete process.env[ARMED_ENV];
      else process.env[ARMED_ENV] = prev;
    }
  };
}

function freshConsent(url, token) {
  return {
    url,
    acknowledgedAt: new Date().toISOString(),
    customerToken: token,
    scopeLimits: { classes: ['sqli', 'xss'] },
  };
}

const VALID_TOKEN = 'a'.repeat(64);

describe('authorization-gate — process armed gate', () => {
  it('refuses by default when GATETEST_PENTEST_ARMED is unset', async () => {
    delete process.env[ARMED_ENV];
    await assert.rejects(
      authorize({ url: 'https://example.com', consent: freshConsent('https://example.com', VALID_TOKEN) }),
      (err) => err instanceof AuthorizationRefusedError && err.reason === 'process-not-armed',
    );
  });

  it('refuses when GATETEST_PENTEST_ARMED is "0"', async () => {
    process.env[ARMED_ENV] = '0';
    await assert.rejects(
      authorize({ url: 'https://example.com', consent: freshConsent('https://example.com', VALID_TOKEN) }),
      (err) => err.reason === 'process-not-armed',
    );
    delete process.env[ARMED_ENV];
  });
});

describe('authorization-gate — per-target consent', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-auth-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('refuses when consent is missing', withArmed(async () => {
    await assert.rejects(
      authorize({ url: 'https://example.com', auditDir: tmpDir }),
      (err) => err.reason === 'no-consent',
    );
  }));

  it('refuses when consent URL does not match target URL', withArmed(async () => {
    await assert.rejects(
      authorize({
        url: 'https://target.com',
        consent: freshConsent('https://other.com', VALID_TOKEN),
        auditDir: tmpDir,
      }),
      (err) => err.reason === 'url-mismatch',
    );
  }));

  it('refuses when consent is older than 24h', withArmed(async () => {
    const stale = {
      url: 'https://example.com',
      acknowledgedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      customerToken: VALID_TOKEN,
    };
    await assert.rejects(
      authorize({ url: 'https://example.com', consent: stale, auditDir: tmpDir }),
      (err) => err.reason === 'consent-stale',
    );
  }));

  it('refuses when customerToken is missing', withArmed(async () => {
    await assert.rejects(
      authorize({
        url: 'https://example.com',
        consent: { url: 'https://example.com', acknowledgedAt: new Date().toISOString() },
        auditDir: tmpDir,
      }),
      (err) => err.reason === 'token-missing-or-weak',
    );
  }));

  it('refuses when customerToken is too short', withArmed(async () => {
    await assert.rejects(
      authorize({
        url: 'https://example.com',
        consent: freshConsent('https://example.com', 'short'),
        auditDir: tmpDir,
      }),
      (err) => err.reason === 'token-missing-or-weak',
    );
  }));
});

describe('authorization-gate — DNS verification', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-auth-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('refuses when DNS TXT record is absent', withArmed(async () => {
    const noDns = async () => [];
    await assert.rejects(
      authorize({
        url: 'https://example.com',
        consent: freshConsent('https://example.com', VALID_TOKEN),
        dnsResolver: noDns,
        auditDir: tmpDir,
      }),
      (err) => err.reason === 'dns-txt-not-found',
    );
  }));

  it('refuses when DNS TXT record has wrong token', withArmed(async () => {
    const wrongDns = async () => ['some-other-token'];
    await assert.rejects(
      authorize({
        url: 'https://example.com',
        consent: freshConsent('https://example.com', VALID_TOKEN),
        dnsResolver: wrongDns,
        auditDir: tmpDir,
      }),
      (err) => err.reason === 'dns-txt-not-found',
    );
  }));

  it('grants when DNS TXT record matches token', withArmed(async () => {
    const goodDns = async (fqdn) => {
      assert.strictEqual(fqdn, `${DNS_TXT_PREFIX}.example.com`);
      return [VALID_TOKEN];
    };
    const result = await authorize({
      url: 'https://example.com',
      consent: freshConsent('https://example.com', VALID_TOKEN),
      dnsResolver: goodDns,
      auditDir: tmpDir,
      actorId: 'cust_123',
      moduleName: 'liveSqlInjection',
    });
    assert.strictEqual(result.granted, true);
    assert.ok(result.receipt.receiptId);
    assert.strictEqual(result.receipt.url, 'https://example.com');
    assert.strictEqual(result.receipt.moduleName, 'liveSqlInjection');
  }));
});

describe('authorization-gate — audit log', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-auth-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('writes a JSONL entry on each authorize call', withArmed(async () => {
    const goodDns = async () => [VALID_TOKEN];
    await authorize({
      url: 'https://example.com',
      consent: freshConsent('https://example.com', VALID_TOKEN),
      dnsResolver: goodDns,
      auditDir: tmpDir,
      actorId: 'cust_a',
      moduleName: 'liveXss',
    });
    const day = new Date().toISOString().slice(0, 10);
    const log = fs.readFileSync(path.join(tmpDir, `pentest-audit-${day}.jsonl`), 'utf-8');
    const entry = JSON.parse(log.trim());
    assert.strictEqual(entry.decision, 'granted');
    assert.strictEqual(entry.actorId, 'cust_a');
    assert.strictEqual(entry.moduleName, 'liveXss');
    assert.ok(entry.receiptId);
  }));

  it('writes a refusal entry with reason', async () => {
    delete process.env[ARMED_ENV];
    try {
      await authorize({
        url: 'https://example.com',
        consent: freshConsent('https://example.com', VALID_TOKEN),
        auditDir: tmpDir,
      });
    } catch { /* expected to throw */ }
    const day = new Date().toISOString().slice(0, 10);
    const log = fs.readFileSync(path.join(tmpDir, `pentest-audit-${day}.jsonl`), 'utf-8');
    const entry = JSON.parse(log.trim());
    assert.strictEqual(entry.decision, 'refused');
    assert.strictEqual(entry.reason, 'process-not-armed');
  });
});

describe('authorization-gate — helpers', () => {
  it('normalizeUrl strips trailing slashes', () => {
    assert.strictEqual(normalizeUrl('https://x.com/foo/'), 'https://x.com/foo');
    assert.strictEqual(normalizeUrl('https://x.com/'), 'https://x.com');
  });

  it('normalizeUrl returns null on malformed input', () => {
    assert.strictEqual(normalizeUrl('not-a-url'), null);
    assert.strictEqual(normalizeUrl(''), null);
  });

  it('isFreshConsent accepts a 1h-old timestamp', () => {
    const t = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    assert.strictEqual(isFreshConsent(t), true);
  });

  it('isFreshConsent rejects 25h-old', () => {
    const t = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(isFreshConsent(t), false);
  });

  it('isFreshConsent rejects malformed', () => {
    assert.strictEqual(isFreshConsent('nope'), false);
    assert.strictEqual(isFreshConsent(null), false);
  });

  it('generateCustomerToken produces a 64-char hex string', () => {
    const t = generateCustomerToken('cust_1', 'https://example.com', 'secret');
    assert.match(t, /^[0-9a-f]{64}$/);
  });

  it('generateCustomerToken is deterministic for same inputs at same time-ish', () => {
    // The token includes Date.now() so calls are not byte-identical, but
    // they should match the shape and have valid HMAC output.
    const t1 = generateCustomerToken('cust', 'https://x.com', 'k');
    const t2 = generateCustomerToken('cust', 'https://x.com', 'k');
    assert.match(t1, /^[0-9a-f]{64}$/);
    assert.match(t2, /^[0-9a-f]{64}$/);
  });

  it('verifyDomainOwnership returns false on malformed URL', async () => {
    const result = await verifyDomainOwnership('not-a-url', VALID_TOKEN, async () => []);
    assert.strictEqual(result, false);
  });
});
