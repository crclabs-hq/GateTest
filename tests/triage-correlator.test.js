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
test('rule 7 — two layers with 3+ errors each → mixed / medium (all layers ran)', () => {
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
  // Browser ran successfully → we have full signal → medium confidence.
  // Low confidence is reserved for the case where the browser scan itself
  // failed and we're guessing from partial signal.
  assert.equal(v.confidence, 'medium');
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
test('summariseLayer — extracts topFindings + drops info + sorts by severity (cap 50)', () => {
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
  // Cap is 50 now (was 5) — all 6 non-info findings survive
  assert.equal(out.topFindings.length, 6);
  // First should be error (sort-by-severity)
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

// ---------- modules[].details[] shape (the real-world bug Craig reported) ----------
test('summariseLayer — extracts findings from modules[].details[] string shape (scan/run output)', () => {
  // This is exactly the shape /api/scan/run + /api/scan/server return.
  // Earlier the correlator's helper only walked modules[].checks[], so all
  // these findings were silently dropped → "unknown / low" verdicts on
  // real-world triages where source had real errors.
  const raw = {
    totalIssues: 42,
    modules: [
      { name: 'syntax', status: 'failed', details: ['src/foo.ts:42: parens mismatch', 'src/bar.ts:7: template-literal'] },
      { name: 'lint', status: 'failed', details: ['error: src/baz.ts:99'] },
      { name: 'links', status: 'passed', details: ['pass: 14 links checked'] },
    ],
  };
  const sum = summariseLayer(raw, { source: 'source' });
  assert.equal(sum.ok, true);
  assert.equal(sum.totalIssues, 42);
  assert.equal(sum.failedModules, 2); // syntax + lint
  assert.ok(sum.topFindings.length >= 3);
  // The "pass:" detail must NOT appear in topFindings
  assert.ok(!sum.topFindings.some((f) => /pass:/.test(f.detail)));
  // Findings from a failed module without explicit severity prefix get
  // promoted to error severity (the module says "failed", so the details
  // are bugs by contract).
  assert.ok(sum.topFindings.some((f) => f.module === 'syntax' && f.severity === 'error'));
  // Explicit "error:" prefix is honoured.
  assert.ok(sum.topFindings.some((f) => f.module === 'lint' && f.severity === 'error'));
});

test('summariseLayer — server-style "warn:" prefix is recognised as warning', () => {
  const raw = {
    totalIssues: 3,
    modules: [
      { name: 'headers', status: 'failed', details: ['warn: missing CSP', 'warn: missing HSTS', 'error: TLS 1.0 enabled'] },
    ],
  };
  const sum = summariseLayer(raw, { source: 'server' });
  const cspWarn = sum.topFindings.find((f) => /CSP/.test(f.detail));
  assert.equal(cspWarn && cspWarn.severity, 'warning');
  const tlsErr = sum.topFindings.find((f) => /TLS 1\.0/.test(f.detail));
  assert.equal(tlsErr && tlsErr.severity, 'error');
});

// ---------- Craig's real-world case: source 42 + server 3 + browser HTTP 500 ----------
test('correlate — source 42 issues + server 3 + browser scan failed → source dominates (Craig scenario)', () => {
  // This was the case that produced "unknown / low" on a real triage run.
  // After the fixes it should localise to source with medium confidence
  // (or mixed if server load is comparable — 42 vs 3 is 14x, well past
  // the 3x dominance threshold).
  const v = correlate({
    source: {
      ok: true,
      totalIssues: 42,
      failedModules: 4,
      topFindings: [
        { module: 'syntax', severity: 'error', detail: 'parens mismatch' },
        { module: 'lint', severity: 'error', detail: 'unused-vars' },
        { module: 'undefinedRef', severity: 'error', detail: 'foo undefined' },
      ],
    },
    server: {
      ok: true,
      totalIssues: 3,
      failedModules: 1,
      topFindings: [
        { module: 'headers', severity: 'warning', detail: 'missing CSP' },
      ],
    },
    browser: {
      ok: false,
      totalIssues: 0,
      failedModules: 0,
      topFindings: [],
      error: 'HTTP 500',
    },
  });
  assertValidVerdict(v);
  assert.equal(v.layer, 'source');
  assert.equal(v.confidence, 'medium');
  assert.match(v.headline, /source layer dominates/i);
  assert.match(v.rationale, /browser scan failed|HTTP 500|no signal/i);
});

test('correlate — server-dominant + browser unavailable → server / medium', () => {
  const v = correlate({
    source: { ok: true, totalIssues: 1, failedModules: 0, topFindings: [] },
    server: { ok: true, totalIssues: 30, failedModules: 5, topFindings: [
      { module: 'headers', severity: 'error', detail: 'no CSP' },
    ]},
    browser: { ok: false, totalIssues: 0, failedModules: 0, topFindings: [], error: 'connection refused' },
  });
  assertValidVerdict(v);
  assert.equal(v.layer, 'server');
  assert.equal(v.confidence, 'medium');
});

test('correlate — comparable source vs server + browser unavailable → mixed / low', () => {
  // Neither dominates by 3x → falls through to rule 7 → mixed.
  // Confidence is low because browser scan was unavailable.
  const v = correlate({
    source: { ok: true, totalIssues: 10, failedModules: 2, topFindings: [
      { module: 'lint', severity: 'error', detail: 'a' },
    ]},
    server: { ok: true, totalIssues: 8, failedModules: 1, topFindings: [
      { module: 'headers', severity: 'error', detail: 'b' },
    ]},
    browser: { ok: false, totalIssues: 0, failedModules: 0, topFindings: [], error: 'HTTP 500' },
  });
  assertValidVerdict(v);
  assert.equal(v.layer, 'mixed');
  assert.equal(v.confidence, 'low');
});

test('summariseLayer — modulesBrief lists every failed module with issue counts', () => {
  const raw = {
    totalIssues: 42,
    modules: [
      { name: 'secrets', status: 'failed', issues: 1, details: ['DB string with credentials'] },
      { name: 'webHeaders', status: 'failed', issues: 12, details: ['error: missing CSP'] },
      { name: 'envVars', status: 'failed', issues: 8 },
      { name: 'commitHistory', status: 'failed', issues: 21 },
      { name: 'links', status: 'passed', issues: 0 },
    ],
  };
  const sum = summariseLayer(raw, { source: 'source' });
  assert.ok(Array.isArray(sum.modulesBrief));
  // 4 failed modules; "links" (passed, 0 issues) is dropped
  assert.equal(sum.modulesBrief.length, 4);
  // Sorted by issue count, biggest first
  assert.equal(sum.modulesBrief[0].name, 'commitHistory');
  assert.equal(sum.modulesBrief[0].issues, 21);
  assert.equal(sum.modulesBrief[1].name, 'webHeaders');
  // Every entry preserves status + issues + name
  for (const m of sum.modulesBrief) {
    assert.equal(typeof m.name, 'string');
    assert.equal(typeof m.status, 'string');
    assert.equal(typeof m.issues, 'number');
  }
});

test('summariseLayer — topFindings cap is now 50 (was 5)', () => {
  // Generate 80 detail strings on a failed module and confirm we keep 50.
  const details = Array.from({ length: 80 }, (_, i) => `error: finding ${i}`);
  const sum = summariseLayer(
    { totalIssues: 80, modules: [{ name: 'lint', status: 'failed', issues: 80, details }] },
    { source: 'source' }
  );
  assert.equal(sum.topFindings.length, 50);
});

test('renderVerdictMarkdown — includes "Module breakdown" when modulesBrief present', () => {
  const md = renderVerdictMarkdown(
    { layer: 'source', confidence: 'medium', headline: 'h', rationale: 'r', recommendedNext: 'n' },
    {
      source: {
        ok: true,
        totalIssues: 5,
        failedModules: 2,
        topFindings: [],
        modulesBrief: [
          { name: 'secrets', status: 'failed', issues: 3 },
          { name: 'webHeaders', status: 'failed', issues: 2 },
        ],
      },
    }
  );
  assert.match(md, /Module breakdown/);
  assert.match(md, /\*\*secrets\*\*.*3 issue/);
  assert.match(md, /\*\*webHeaders\*\*.*2 issue/);
});

test('correlate — single failed module on source layer triggers latent rule 6', () => {
  // failedModules>=1 should be enough — we no longer need 3+ topFindings
  // entries to recognise that a layer has errors.
  const v = correlate({
    source: { ok: true, totalIssues: 5, failedModules: 1, topFindings: [] },
    server: { ok: true, totalIssues: 0, failedModules: 0, topFindings: [] },
    browser: { ok: true, totalIssues: 0, failedModules: 0, topFindings: [] },
  });
  assertValidVerdict(v);
  assert.equal(v.layer, 'source');
  assert.match(v.headline, /latent/i);
});
