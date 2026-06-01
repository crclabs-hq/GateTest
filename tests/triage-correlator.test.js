'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  correlate,
  summariseLayer,
  renderVerdictMarkdown,
} = require('../website/app/lib/triage/correlator.js');

// ---------- helpers ----------
function layer({ ok = true, totalIssues = 0, failedModules = 0, topFindings = [], error } = {}) {
  return { ok, totalIssues, failedModules, topFindings, error };
}
function finding(module, severity, detail) {
  return { module, severity, detail };
}

const VALID_LAYERS = ['source', 'server', 'browser', 'build', 'mixed', 'unknown'];
const VALID_CONFIDENCE = ['high', 'medium', 'low'];

function assertValidVerdict(v) {
  assert.ok(v && typeof v === 'object', 'verdict is object');
  assert.ok(VALID_LAYERS.includes(v.layer), `layer is valid: got ${v.layer}`);
  assert.ok(VALID_CONFIDENCE.includes(v.confidence), `confidence valid: got ${v.confidence}`);
  assert.equal(typeof v.headline, 'string');
  assert.ok(v.headline.length <= 200, 'headline reasonable length');
  assert.equal(typeof v.rationale, 'string');
  assert.equal(typeof v.recommendedNext, 'string');
}

// ---------- Rule 1: all three failed ----------
test('rule 1 — all three layers failed to run → unknown / low', () => {
  const v = correlate({
    source: layer({ ok: false, error: 'crashed' }),
    server: layer({ ok: false, error: 'crashed' }),
    browser: layer({ ok: false, error: 'crashed' }),
  });
  assertValidVerdict(v);
  assert.equal(v.layer, 'unknown');
  assert.equal(v.confidence, 'low');
  assert.match(v.headline, /All three scans failed/i);
});

// ---------- Rule 2: server 5xx + browser couldn't paint ----------
test('rule 2 — server 5xx + browser network errors → server / high', () => {
  const v = correlate({
    source: layer({ ok: true, totalIssues: 0 }),
    server: layer({
      ok: true,
      totalIssues: 1,
      topFindings: [finding('http', 'error', 'origin returned 503 Service Unavailable')],
    }),
    browser: layer({
      ok: true,
      totalIssues: 1,
      topFindings: [finding('runtimeErrors', 'error', 'network fetch-fail on /api/me')],
    }),
  });
  assertValidVerdict(v);
  assert.equal(v.layer, 'server');
  assert.equal(v.confidence, 'high');
});

test('rule 2 — server unreachable (ok:false) + browser failed to load', () => {
  const v = correlate({
    source: layer({ ok: true }),
    server: layer({ ok: false, error: 'connection refused' }),
    browser: layer({ ok: false, error: 'navigation failed' }),
  });
  assert.equal(v.layer, 'server');
  assert.equal(v.confidence, 'high');
});

test('rule 2 — timed-out server + playwright-not-available browser', () => {
  const v = correlate({
    source: layer({ ok: true }),
    server: layer({
      ok: true,
      totalIssues: 1,
      topFindings: [finding('probe', 'error', 'request timed out after 30s')],
    }),
    browser: layer({
      ok: true,
      totalIssues: 1,
      topFindings: [finding('runtimeErrors', 'info', 'playwright not available in this environment')],
    }),
  });
  assert.equal(v.layer, 'server');
});

// ---------- Rule 3: browser hydration mismatch + source clean ----------
test('rule 3 — browser hydration mismatch + source clean + server healthy → build / medium', () => {
  const v = correlate({
    source: layer({ ok: true, totalIssues: 0 }),
    server: layer({ ok: true, totalIssues: 0 }),
    browser: layer({
      ok: true,
      totalIssues: 1,
      topFindings: [finding('runtimeErrors', 'error', 'hydration mismatch on <Header>')],
    }),
  });
  assertValidVerdict(v);
  assert.equal(v.layer, 'build');
  assert.equal(v.confidence, 'medium');
  assert.match(v.recommendedNext, /deploy|build|bundle/i);
});

test('rule 3 — chunkLoadError + clean source → build', () => {
  const v = correlate({
    source: layer({ ok: true, totalIssues: 0 }),
    server: layer({ ok: true, totalIssues: 0 }),
    browser: layer({
      ok: true,
      totalIssues: 1,
      topFindings: [finding('runtimeErrors', 'error', 'ChunkLoadError: Loading chunk 47 failed')],
    }),
  });
  assert.equal(v.layer, 'build');
});

// ---------- Rule 4: source + browser errors of same family ----------
test('rule 4 — source errorSwallow + browser page-error → source / high', () => {
  const v = correlate({
    source: layer({
      ok: true,
      totalIssues: 3,
      topFindings: [finding('errorSwallow', 'error', 'empty catch in payments.js')],
    }),
    server: layer({ ok: true, totalIssues: 0 }),
    browser: layer({
      ok: true,
      totalIssues: 2,
      topFindings: [finding('runtimeErrors', 'error', 'page-error: undefined is not a function')],
    }),
  });
  assertValidVerdict(v);
  assert.equal(v.layer, 'source');
  assert.equal(v.confidence, 'high');
});

test('rule 4 — source raceCondition module + browser uncaught → source', () => {
  const v = correlate({
    source: layer({
      ok: true,
      totalIssues: 1,
      topFindings: [finding('raceCondition', 'error', 'TOCTOU pattern on cache write')],
    }),
    server: layer({ ok: true }),
    browser: layer({
      ok: true,
      totalIssues: 1,
      topFindings: [finding('console', 'error', 'Uncaught TypeError in handler')],
    }),
  });
  assert.equal(v.layer, 'source');
});

// ---------- Rule 5: missing CSP server-side, nothing else ----------
test('rule 5 — server missing CSP + clean source + clean browser → server / medium', () => {
  const v = correlate({
    source: layer({ ok: true, totalIssues: 0 }),
    server: layer({
      ok: true,
      totalIssues: 1,
      topFindings: [finding('headers', 'error', 'missing Content-Security-Policy header')],
    }),
    browser: layer({ ok: true, totalIssues: 0 }),
  });
  assertValidVerdict(v);
  assert.equal(v.layer, 'server');
  assert.equal(v.confidence, 'medium');
});

test('rule 5 — server HSTS missing → server / medium', () => {
  const v = correlate({
    source: layer({ ok: true, totalIssues: 0 }),
    server: layer({
      ok: true,
      totalIssues: 1,
      topFindings: [finding('headers', 'error', 'HSTS strict-transport-security missing')],
    }),
    browser: layer({ ok: true, totalIssues: 0 }),
  });
  assert.equal(v.layer, 'server');
});

// ---------- Rule 6: source errors, server + browser healthy ----------
test('rule 6 — source errors, server + browser healthy → source / medium (latent)', () => {
  const v = correlate({
    source: layer({
      ok: true,
      totalIssues: 2,
      topFindings: [finding('moneyFloat', 'error', 'parseFloat on price variable')],
    }),
    server: layer({ ok: true, totalIssues: 0 }),
    browser: layer({ ok: true, totalIssues: 0 }),
  });
  assertValidVerdict(v);
  assert.equal(v.layer, 'source');
  assert.equal(v.confidence, 'medium');
  assert.match(v.headline, /latent/i);
});

// ---------- Rule 7: three-way mess ----------
test('rule 7 — two layers with 3+ errors each → mixed / low', () => {
  const v = correlate({
    source: layer({
      ok: true,
      totalIssues: 5,
      topFindings: [
        finding('lint', 'error', 'a'),
        finding('lint', 'error', 'b'),
        finding('lint', 'error', 'c'),
      ],
    }),
    server: layer({
      ok: true,
      totalIssues: 5,
      topFindings: [
        finding('headers', 'error', 'x'),
        finding('headers', 'error', 'y'),
        finding('headers', 'error', 'z'),
      ],
    }),
    browser: layer({ ok: true, totalIssues: 0 }),
  });
  assertValidVerdict(v);
  assert.equal(v.layer, 'mixed');
  assert.equal(v.confidence, 'low');
});

test('rule 7 — all three layers with 3+ errors each → mixed', () => {
  const mk = (mod) => layer({
    ok: true,
    totalIssues: 9,
    topFindings: [
      finding(mod, 'error', '1'),
      finding(mod, 'error', '2'),
      finding(mod, 'error', '3'),
      finding(mod, 'error', '4'),
    ],
  });
  const v = correlate({ source: mk('lint'), server: mk('hdr'), browser: mk('rt') });
  assert.equal(v.layer, 'mixed');
});

// ---------- Rule 8: all clean ----------
test('rule 8 — zero issues across all three → unknown / high (green)', () => {
  const v = correlate({
    source: layer({ ok: true, totalIssues: 0 }),
    server: layer({ ok: true, totalIssues: 0 }),
    browser: layer({ ok: true, totalIssues: 0 }),
  });
  assertValidVerdict(v);
  assert.equal(v.layer, 'unknown');
  assert.equal(v.confidence, 'high');
  assert.match(v.headline, /no issues/i);
});

// ---------- Rule 9: fallback ----------
test('rule 9 — fallback when nothing matches → unknown / low', () => {
  // A handful of warnings spread thinly, no errors, no special patterns.
  const v = correlate({
    source: layer({
      ok: true,
      totalIssues: 1,
      topFindings: [finding('lint', 'warning', 'consider using const')],
    }),
    server: layer({ ok: true, totalIssues: 0 }),
    browser: layer({ ok: true, totalIssues: 0 }),
  });
  assertValidVerdict(v);
  assert.equal(v.layer, 'unknown');
  assert.equal(v.confidence, 'low');
});

// ---------- summariseLayer ----------
test('summariseLayer — extracts topFindings + caps at 5 + sorts by severity', () => {
  const raw = {
    ok: true,
    totalIssues: 8,
    topFindings: [
      { module: 'a', severity: 'warning', detail: 'w1' },
      { module: 'b', severity: 'error', detail: 'e1' },
      { module: 'c', severity: 'info', detail: 'i1' },
      { module: 'd', severity: 'error', detail: 'e2' },
      { module: 'e', severity: 'warning', detail: 'w2' },
      { module: 'f', severity: 'error', detail: 'e3' },
      { module: 'g', severity: 'error', detail: 'e4' },
    ],
  };
  const out = summariseLayer(raw, { source: 'source' });
  assert.equal(out.topFindings.length, 5);
  // First should be error
  assert.equal(out.topFindings[0].severity, 'error');
  // No info because non-info available
  assert.ok(!out.topFindings.some((f) => f.severity === 'info'));
});

test('summariseLayer — drops info only when non-info available', () => {
  const raw = {
    ok: true,
    topFindings: [
      { module: 'a', severity: 'info', detail: 'i1' },
      { module: 'b', severity: 'info', detail: 'i2' },
    ],
  };
  const out = summariseLayer(raw, { source: 'browser' });
  // Only info-severity — keep them since nothing else available
  assert.equal(out.topFindings.length, 2);
});

test('summariseLayer — null input returns safe layer', () => {
  const out = summariseLayer(null, { source: 'server' });
  assert.equal(out.ok, false);
  assert.equal(out.totalIssues, 0);
  assert.deepEqual(out.topFindings, []);
});

test('summariseLayer — derives findings from modules[].checks shape', () => {
  const raw = {
    ok: true,
    modules: [
      { name: 'headers', status: 'failed', checks: [{ severity: 'error', message: 'missing CSP' }] },
      { name: 'lint', status: 'passed', checks: [{ severity: 'warning', message: 'unused var' }] },
    ],
  };
  const out = summariseLayer(raw, { source: 'source' });
  assert.equal(out.failedModules, 1);
  assert.ok(out.topFindings.length >= 1);
  assert.equal(out.topFindings[0].severity, 'error');
});

test('summariseLayer — ok is false when raw.error present', () => {
  const out = summariseLayer({ error: 'boom' }, { source: 'server' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'boom');
});

test('summariseLayer — caps detail at 200 chars', () => {
  const longDetail = 'x'.repeat(500);
  const out = summariseLayer({
    ok: true,
    topFindings: [{ module: 'm', severity: 'error', detail: longDetail }],
  });
  assert.ok(out.topFindings[0].detail.length <= 200);
});

// ---------- renderVerdictMarkdown ----------
test('renderVerdictMarkdown — contains headline, rationale, recommendedNext, and three layer sections', () => {
  const verdict = {
    layer: 'server',
    confidence: 'high',
    headline: 'Server is on fire',
    rationale: 'Because reasons.',
    recommendedNext: 'Call the SRE team.',
  };
  const layers = {
    source: layer({ ok: true, totalIssues: 0 }),
    server: layer({
      ok: true,
      totalIssues: 1,
      topFindings: [finding('headers', 'error', 'missing CSP')],
    }),
    browser: layer({ ok: true, totalIssues: 0 }),
  };
  const md = renderVerdictMarkdown(verdict, layers);
  assert.match(md, /## Server is on fire/);
  assert.match(md, /Because reasons\./);
  assert.match(md, /Call the SRE team\./);
  assert.match(md, /### Source layer/);
  assert.match(md, /### Server layer/);
  assert.match(md, /### Browser layer/);
  assert.match(md, /missing CSP/);
  assert.match(md, /`server`/);
  assert.match(md, /`high`/);
});

test('renderVerdictMarkdown — handles missing layers gracefully', () => {
  const md = renderVerdictMarkdown(
    { layer: 'unknown', confidence: 'low', headline: 'h', rationale: 'r', recommendedNext: 'n' },
    {}
  );
  assert.match(md, /## h/);
  assert.match(md, /no data/i);
});

test('renderVerdictMarkdown — handles null verdict + null layers gracefully', () => {
  const md = renderVerdictMarkdown(null, null);
  assert.equal(typeof md, 'string');
  assert.ok(md.length > 0);
});

// ---------- defensive ----------
test('defensive — correlate(null) returns valid verdict', () => {
  const v = correlate(null);
  assertValidVerdict(v);
});

test('defensive — correlate({}) returns valid verdict', () => {
  const v = correlate({});
  assertValidVerdict(v);
});

test('defensive — correlate with partial input', () => {
  const v = correlate({ source: layer({ ok: true }) });
  assertValidVerdict(v);
});

test('defensive — correlate with garbage fields does not throw', () => {
  const v = correlate({
    source: 'not an object',
    server: 42,
    browser: ['nope'],
  });
  assertValidVerdict(v);
});

test('defensive — correlate with missing topFindings array', () => {
  const v = correlate({
    source: { ok: true, totalIssues: 5 },
    server: { ok: true, totalIssues: 0 },
    browser: { ok: true, totalIssues: 0 },
  });
  assertValidVerdict(v);
});

test('defensive — correlate with non-finite numbers', () => {
  const v = correlate({
    source: { ok: true, totalIssues: NaN, failedModules: Infinity, topFindings: [] },
    server: { ok: true, totalIssues: 'x', topFindings: [] },
    browser: { ok: true, totalIssues: 0, topFindings: [] },
  });
  assertValidVerdict(v);
  // Bad totalIssues coerces to 0 → all clean → rule 8
  assert.equal(v.layer, 'unknown');
});

test('module.exports — contract surface is exactly {correlate, summariseLayer, renderVerdictMarkdown}', () => {
  const mod = require('../website/app/lib/triage/correlator.js');
  const keys = Object.keys(mod).sort();
  assert.deepEqual(keys, ['correlate', 'renderVerdictMarkdown', 'summariseLayer']);
  assert.equal(typeof mod.correlate, 'function');
  assert.equal(typeof mod.summariseLayer, 'function');
  assert.equal(typeof mod.renderVerdictMarkdown, 'function');
});
