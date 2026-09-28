'use strict';
/**
 * Telemetry host guard (issue #801). @gatetest/cli 1.60.0 shipped an upload
 * URL on a domain that later dropped, so every install of it posted scan stats
 * to a name we no longer own. These tests fail if the upload host, resolved
 * with no override, is anything but gatetest.io, or if the files that decide
 * it name any other host.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { resolveTelemetryTarget, TELEMETRY_HOST } = require('../src/core/telemetry-uploader');
const { foreignHosts, hostViolations, ALLOWED_HOST } = require('../scripts/sync-lib');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('telemetry host guard — resolved upload URL', () => {
  it('with no override the upload goes to gatetest.io', () => {
    const t = resolveTelemetryTarget({});
    assert.strictEqual(t.host, 'gatetest.io');
    assert.strictEqual(t.url, 'https://gatetest.io/api/telemetry/scan');
    assert.strictEqual(t.allowed, true);
    assert.strictEqual(TELEMETRY_HOST, 'gatetest.io');
  });

  it('the guard follows the resolved origin: a base-URL override to another host is refused', () => {
    const t = resolveTelemetryTarget({ NEXT_PUBLIC_BASE_URL: 'https://stale.example' });
    assert.strictEqual(t.allowed, false, 'a stale base URL must not silently redirect uploads');
  });

  it('an unparsable endpoint is refused, not sent', () => {
    assert.strictEqual(resolveTelemetryTarget({ GATETEST_TELEMETRY_URL: 'not a url' }).allowed, false);
  });
});

describe('telemetry host guard — shipped files name only gatetest.io', () => {
  for (const rel of ['lib/site-url.js', 'src/core/site-url.js', 'src/core/telemetry-uploader.js', 'website/app/lib/site-url.js']) {
    it(`${rel} names no other host`, () => {
      assert.deepStrictEqual(foreignHosts(read(rel)), []);
    });
  }

  // Positive control: a detector that reports silence must be shown to fire.
  it('the detector fires on a dead-domain URL and on a bare hostname', () => {
    assert.deepStrictEqual(foreignHosts("const D = 'https://gatetest.ai';"), ['gatetest.ai']);
    assert.deepStrictEqual(foreignHosts('see evil.example.com/path'), ['evil.example.com']);
    assert.deepStrictEqual(foreignHosts("'https://gatetest.io' and support@gatetest.io"), []);
  });

  it('sync-lib refuses a shipped site-url.js that names another host', () => {
    assert.strictEqual(ALLOWED_HOST, 'gatetest.io');
    const bad = hostViolations([{ name: 'site-url.js', content: "const D = 'https://gatetest.ai';" }]);
    assert.deepStrictEqual(bad, [{ file: 'site-url.js', hosts: ['gatetest.ai'] }]);
    const good = hostViolations([{ name: 'site-url.js', content: "const D = 'https://gatetest.io';" }]);
    assert.deepStrictEqual(good, []);
  });

  it('the real lib/ has no host violations', () => {
    assert.deepStrictEqual(hostViolations(), []);
  });
});
