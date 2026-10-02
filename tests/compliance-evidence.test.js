'use strict';

// src/core/compliance-evidence.js — findings filed under OWASP / CIS control
// by control, three-state (the Fifty, move 46). No SOC 2: that is a future,
// separate product (Craig 2026-10-01), so the pack must not present it. The controls that
// matter are the ones that must NOT read as a pass: a control no mapped
// module ran for, and a module with findings but no mapping.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildComplianceEvidence, renderComplianceMarkdown, bucketOf } = require('../src/core/compliance-evidence');
const { getComplianceMapping, hasExplicitMapping } = require('../src/core/compliance-mappings');

const check = (name, extra) => ({ name, passed: false, severity: 'error', confidence: 1, ...extra });
const summary = () => ({
  timestamp: '2026-09-05T05:00:00.000Z',
  gateStatus: 'BLOCKED',
  confidenceThreshold: 0.7,
  deferred: [{ module: 'mutation', reason: 'slow', runsIn: 'nightly' }],
  results: [
    { module: 'ssrf', status: 'failed', checks: [check('ssrf:fetch', { file: 'src/a.js', line: 3 })] },
    { module: 'secrets', status: 'failed', checks: [check('secrets:key', { confidence: 0.3, file: 'docs/x.md', line: 1 })] },
    { module: 'tlsSecurity', status: 'passed', checks: [{ name: 'tls:ok', passed: true }] },
    { module: 'flakyTests', status: 'failed', checks: [check('flaky:skip', { severity: 'warning' })] },
    { module: 'noSuchModule', status: 'failed', checks: [check('x:y', { file: 'a.js', line: 1 })] },
    { module: 'kubernetes', status: 'skipped', checks: [] },
  ],
});

test('bucketOf mirrors the gate: blocking, soft below the threshold, warning, suppressed, nothing for passes/info', () => {
  assert.equal(bucketOf(check('a'), 0.7), 'blocking');
  assert.equal(bucketOf(check('a', { confidence: 0.5 }), 0.7), 'soft');
  assert.equal(bucketOf(check('a', { severity: 'warning' }), 0.7), 'warning');
  assert.equal(bucketOf(check('a', { suppressed: true }), 0.7), 'suppressed');
  assert.equal(bucketOf({ name: 'a', passed: true }, 0.7), null);
  assert.equal(bucketOf(check('a', { severity: 'info' }), 0.7), null);
});

test('a blocking finding from a mapped module fails its controls, with the evidence line', () => {
  const ev = buildComplianceEvidence(summary());
  assert.ok(hasExplicitMapping('ssrf'));
  for (const id of getComplianceMapping('ssrf').owasp) {
    const c = ev.frameworks.owasp.controls[id];
    assert.equal(c.status, 'fail', id);
    assert.ok(c.modules.ran.includes('ssrf'));
    assert.deepEqual(c.evidence.find((e) => e.module === 'ssrf'), { module: 'ssrf', check: 'ssrf:fetch', file: 'src/a.js', line: 3, severity: 'blocking', confidence: 1 });
  }
});

test('a soft error is WARN, never FAIL and never PASS', () => {
  const ev = buildComplianceEvidence(summary());
  const [id] = getComplianceMapping('secrets').cis;
  const c = ev.frameworks.cis.controls[id];
  assert.equal(c.findings.soft, 1);
  assert.notEqual(c.status, 'pass');
  assert.notEqual(c.status, 'fail');
});

test('PASS needs a mapped module that RAN and found nothing; a control nobody ran for is NOT CHECKED', () => {
  const ev = buildComplianceEvidence(summary());
  // tlsSecurity ran clean: its controls that no failing module shares are pass
  const tlsOnly = getComplianceMapping('tlsSecurity').cis.filter((id) => ev.frameworks.cis.controls[id].modules.ran.every((m) => m === 'tlsSecurity'));
  assert.ok(tlsOnly.length > 0, 'fixture needs a control only tlsSecurity ran for');
  for (const id of tlsOnly) assert.equal(ev.frameworks.cis.controls[id].status, 'pass', id);

  const notChecked = Object.entries(ev.frameworks.owasp.controls).filter(([, c]) => c.status === 'not-checked');
  assert.ok(notChecked.length > 0, 'a suite that ran five modules cannot have checked all ten OWASP categories');
  for (const [id, c] of notChecked) {
    assert.equal(c.modules.ran.length, 0, id);
    assert.ok(c.modules.notRun.length > 0, `${id} has mapped modules that did not run`);
  }
  const ev2 = buildComplianceEvidence({ ...summary(), results: [] });
  assert.equal(Object.values(ev2.frameworks.owasp.controls).filter((c) => c.status === 'pass').length, 0, 'an empty run passes nothing');
});

test('a module that did not run is named with WHY — skipped, deferred, or not in this suite', () => {
  const ev = buildComplianceEvidence(summary());
  const reasons = new Map();
  for (const fw of Object.values(ev.frameworks)) for (const c of Object.values(fw.controls)) for (const n of c.modules.notRun) reasons.set(n.module, n.reason);
  assert.equal(reasons.get('kubernetes'), 'skipped');
  assert.equal(reasons.get('cookieSecurity'), 'not in this suite');
  // mutation maps to no control, so it never appears in a control's notRun —
  // it is still named in the pack's own not-run section.
  assert.equal(reasons.has('mutation'), false);
  assert.deepEqual(ev.attribution.notRun, { skipped: ['kubernetes'], deferred: ['mutation'] });
});

test('a module without a mapping never feeds a control — it is listed as unattributed', () => {
  const ev = buildComplianceEvidence(summary());
  assert.equal(hasExplicitMapping('noSuchModule'), false);
  for (const fw of Object.values(ev.frameworks)) for (const c of Object.values(fw.controls)) assert.ok(!c.modules.ran.includes('noSuchModule'));
  assert.deepEqual(ev.attribution.unattributed, [{ module: 'noSuchModule', blocking: 1, soft: 0, warning: 0, suppressed: 0 }]);
  assert.deepEqual(ev.attribution.explicit, ['flakyTests', 'secrets', 'ssrf', 'tlsSecurity']);
});

test('totals add up per framework', () => {
  const ev = buildComplianceEvidence(summary());
  for (const [key, t] of Object.entries(ev.totals)) {
    const n = Object.keys(ev.frameworks[key].controls).length;
    assert.equal(t.controls, n, key);
    assert.equal(t.pass + t.fail + t.warn + t['not-checked'] + t['no-module'], n, key);
  }
});

test('the Markdown says what was not checked and never dresses silence as a pass', () => {
  const ev = buildComplianceEvidence(summary());
  const md = renderComplianceMarkdown(ev, { version: '9.9.9', timestamp: 'T', gateStatus: 'BLOCKED', signed: false });
  assert.match(md, /A10:2021 \| Server-Side Request Forgery \(SSRF\) \| FAIL \| ssrf/);
  assert.match(md, /NOT CHECKED/);
  assert.match(md, /kubernetes \(skipped\)/);
  assert.match(md, /Deferred to another suite: mutation/);
  assert.match(md, /\| noSuchModule \| 1 \| 0 \| 0 \|/);
  assert.match(md, /Unsigned — set GATETEST_REPORT_SIGNING_KEY/);
  const signed = renderComplianceMarkdown(ev, { signed: true, keyId: 'abc123' });
  assert.match(signed, /Signed \(HMAC-SHA256, key id abc123\)/);
});

test('the pack covers OWASP Top 10 2021 and CIS Controls v8 only — no SOC 2 (Craig 2026-10-01: a future product, not sold today)', () => {
  const ev = buildComplianceEvidence(summary());
  assert.deepEqual(Object.keys(ev.frameworks).sort(), ['cis', 'owasp']);
  assert.deepEqual(Object.keys(ev.totals).sort(), ['cis', 'owasp']);
  assert.equal(ev.frameworks.owasp.name, 'OWASP Top 10 2021');
  assert.equal(ev.frameworks.cis.name, 'CIS Controls v8');
  const md = renderComplianceMarkdown(ev, { version: '9.9.9', timestamp: 'T', gateStatus: 'BLOCKED', signed: false });
  assert.match(md, /## OWASP Top 10 2021/);
  assert.match(md, /## CIS Controls v8/);
  assert.doesNotMatch(md, /SOC ?2|Trust Services/i);
  assert.doesNotMatch(JSON.stringify(ev), /SOC ?2|Trust Services/i);
  // The soc2 column stays in the mapping table for the future product.
  assert.ok(getComplianceMapping('ssrf').soc2.length > 0);
});
