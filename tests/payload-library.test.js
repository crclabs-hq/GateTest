const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  SQL_INJECTION_PAYLOADS, XSS_PAYLOADS, PATH_TRAVERSAL_PAYLOADS,
  PATH_TRAVERSAL_MARKERS, OPEN_REDIRECT_PAYLOADS, AUTH_BYPASS_HEADERS,
  CSRF_DETECTION_HEADERS, getPayloadsByClass, summarisePayloadSet,
} = require('../src/core/payload-library');

const { isForbiddenPayload } = require('../src/core/live-probe-runner');

describe('payload-library — SQL injection set', () => {
  it('exists and is non-empty', () => {
    assert.ok(Array.isArray(SQL_INJECTION_PAYLOADS));
    assert.ok(SQL_INJECTION_PAYLOADS.length >= 10);
  });

  it('covers error / boolean / comment / union / timing classes', () => {
    const classes = new Set(SQL_INJECTION_PAYLOADS.map((p) => p.class));
    for (const c of ['error', 'boolean-true', 'boolean-false', 'comment', 'union', 'timing']) {
      assert.ok(classes.has(c), `missing class: ${c}`);
    }
  });

  it('every payload passes the forbidden-pattern filter (safe to transmit)', () => {
    for (const p of SQL_INJECTION_PAYLOADS) {
      assert.strictEqual(
        isForbiddenPayload(p.payload), false,
        `payload would be blocked: ${p.payload}`,
      );
    }
  });

  it('every payload has a detect marker', () => {
    for (const p of SQL_INJECTION_PAYLOADS) {
      assert.ok(typeof p.detect === 'string' && p.detect.length > 0);
    }
  });
});

describe('payload-library — XSS set', () => {
  it('exists and is non-empty', () => {
    assert.ok(XSS_PAYLOADS.length >= 5);
  });

  it('all payloads carry the probe marker', () => {
    for (const p of XSS_PAYLOADS) {
      assert.ok(p.payload.includes('__gatetest_xss_probe__') || p.payload.startsWith('javascript:') || p.payload.includes('script'));
    }
  });

  it('passes forbidden filter', () => {
    for (const p of XSS_PAYLOADS) {
      assert.strictEqual(isForbiddenPayload(p.payload), false);
    }
  });
});

describe('payload-library — Path traversal set', () => {
  it('exists and covers unix + windows + encoded forms', () => {
    const classes = new Set(PATH_TRAVERSAL_PAYLOADS.map((p) => p.class));
    assert.ok(classes.has('unix-passwd'));
    assert.ok(classes.has('windows'));
    assert.ok(classes.has('url-encoded'));
  });

  it('detection markers are valid regex', () => {
    for (const [name, re] of Object.entries(PATH_TRAVERSAL_MARKERS)) {
      assert.ok(re instanceof RegExp, `${name} should be RegExp`);
    }
  });

  it('passwd marker matches canonical /etc/passwd line', () => {
    assert.ok(PATH_TRAVERSAL_MARKERS['passwd-marker'].test('root:x:0:0:root:/root:/bin/bash'));
  });

  it('win-ini marker matches canonical win.ini header', () => {
    assert.ok(PATH_TRAVERSAL_MARKERS['win-ini-marker'].test('[boot loader]\n'));
  });
});

describe('payload-library — Open redirect set', () => {
  it('exists', () => {
    assert.ok(OPEN_REDIRECT_PAYLOADS.length >= 4);
  });

  it('all use the probe-invalid domain', () => {
    for (const p of OPEN_REDIRECT_PAYLOADS) {
      assert.ok(
        p.payload.includes('gatetest-probe.invalid'),
        `payload should target gatetest-probe.invalid: ${p.payload}`,
      );
    }
  });
});

describe('payload-library — Auth bypass headers', () => {
  it('exists and covers forwarded / admin / method-override / host-spoof', () => {
    const classes = new Set(AUTH_BYPASS_HEADERS.map((h) => h.class));
    for (const c of ['forwarded', 'admin', 'method-override', 'host-spoof']) {
      assert.ok(classes.has(c));
    }
  });

  it('every entry has a headers object and detect marker', () => {
    for (const e of AUTH_BYPASS_HEADERS) {
      assert.ok(typeof e.headers === 'object');
      assert.ok(typeof e.detect === 'string');
    }
  });
});

describe('payload-library — CSRF detection headers', () => {
  it('uses the probe-invalid origin', () => {
    assert.match(CSRF_DETECTION_HEADERS.Origin, /gatetest-probe\.invalid/);
    assert.match(CSRF_DETECTION_HEADERS.Referer, /gatetest-probe\.invalid/);
  });
});

describe('payload-library — helpers', () => {
  it('getPayloadsByClass filters by class', () => {
    const errors = getPayloadsByClass(SQL_INJECTION_PAYLOADS, 'error');
    assert.ok(errors.length > 0);
    for (const e of errors) assert.strictEqual(e.class, 'error');
  });

  it('summarisePayloadSet counts totals + per-class', () => {
    const s = summarisePayloadSet(SQL_INJECTION_PAYLOADS);
    assert.strictEqual(s.total, SQL_INJECTION_PAYLOADS.length);
    assert.ok(typeof s.byClass === 'object');
    assert.ok(s.byClass.error >= 1);
  });
});
