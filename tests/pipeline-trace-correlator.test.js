'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  trace,
  compareShas,
  renderTraceMarkdown,
} = require('../website/app/lib/pipeline-trace/correlator.js');

// ---------- helpers ----------
function stage({
  ok = true,
  sha = null,
  shortSha = null,
  timestamp = null,
  ageMinutes = null,
  conclusion = null,
  state = null,
  url = null,
  details = [],
  error,
} = {}) {
  return { ok, sha, shortSha, timestamp, ageMinutes, conclusion, state, url, details, error };
}

const VALID_LAYERS = ['source', 'ci', 'deploy', 'live', 'edge', 'synced', 'unknown'];
const VALID_CONFIDENCE = ['high', 'medium', 'low'];
const VALID_DIVERGENCE = [
  'ci-not-built',
  'ci-failed',
  'deploy-behind',
  'deploy-failed',
  'live-stale',
  'edge-cache',
  'in-sync',
  'no-signal',
];
const VALID_STAGE_NAMES = ['source', 'ci', 'deploy', 'live'];
const VALID_STAGE_STATUS = ['in-sync', 'ahead', 'behind', 'unknown'];

function assertValidVerdict(v) {
  assert.ok(v && typeof v === 'object', 'verdict is object');
  assert.ok(VALID_LAYERS.includes(v.layer), `layer valid: got ${v.layer}`);
  assert.ok(VALID_CONFIDENCE.includes(v.confidence), `confidence valid: got ${v.confidence}`);
  assert.ok(VALID_DIVERGENCE.includes(v.divergencePoint), `divergencePoint valid: got ${v.divergencePoint}`);
  assert.equal(typeof v.headline, 'string');
  assert.ok(v.headline.length > 0 && v.headline.length <= 240, 'headline reasonable length');
  assert.equal(typeof v.rationale, 'string');
  assert.equal(typeof v.recommendedNext, 'string');
}

function assertValidStages(stages) {
  assert.ok(Array.isArray(stages));
  assert.equal(stages.length, 4);
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    assert.equal(s.name, VALID_STAGE_NAMES[i]);
    assert.ok(s.state && typeof s.state === 'object');
    assert.ok(VALID_STAGE_STATUS.includes(s.status), `status valid for ${s.name}: got ${s.status}`);
  }
  assert.equal(stages[0].comparedTo, undefined, 'source has no comparedTo');
  assert.equal(stages[1].comparedTo, 'source');
  assert.equal(stages[2].comparedTo, 'ci');
  assert.equal(stages[3].comparedTo, 'deploy');
  assert.equal(stages[0].status, 'in-sync', 'source is always in-sync baseline');
}

// ---------- compareShas ----------
test('compareShas — equal short shas', () => {
  assert.equal(compareShas('abc1234', 'abc1234'), 'equal');
});

test('compareShas — equal short vs full sha', () => {
  assert.equal(
    compareShas('abc1234', 'abc1234567890abcdef1234567890abcdef12345'),
    'equal'
  );
});

test('compareShas — equal full vs short sha', () => {
  assert.equal(
    compareShas('abc1234567890abcdef1234567890abcdef12345', 'abc1234'),
    'equal'
  );
});

test('compareShas — case-insensitive + different + too-short', () => {
  assert.equal(compareShas('ABC1234', 'abc1234'), 'equal');
  assert.equal(compareShas('abc1234', 'def5678'), 'different');
  assert.equal(compareShas('def56789999999999999999999999999999', 'abc1234'), 'different');
  assert.equal(compareShas('abc', 'abc'), 'unknown');
});

test('compareShas — null / empty / non-string inputs return unknown', () => {
  assert.equal(compareShas(null, 'abc1234'), 'unknown');
  assert.equal(compareShas('abc1234', null), 'unknown');
  assert.equal(compareShas(null, null), 'unknown');
  assert.equal(compareShas('', 'abc1234'), 'unknown');
  assert.equal(compareShas(123, 'abc1234'), 'unknown');
  assert.equal(compareShas({}, 'abc1234'), 'unknown');
  assert.equal(compareShas(undefined, 'abc1234'), 'unknown');
});

// ---------- Rule 1: no source signal ----------
test('rule 1 — source.ok=false → unknown / no-signal / low', () => {
  const { verdict, stages } = trace({
    source: stage({ ok: false, error: 'github 404' }),
    ci: stage({ ok: true, sha: 'abc1234' }),
    deploy: stage({ ok: true, sha: 'abc1234' }),
    live: stage({ ok: true, sha: 'abc1234' }),
  });
  assertValidVerdict(verdict);
  assertValidStages(stages);
  assert.equal(verdict.layer, 'unknown');
  assert.equal(verdict.divergencePoint, 'no-signal');
  assert.equal(verdict.confidence, 'low');
  assert.match(verdict.headline, /source HEAD/i);
});

test('rule 1 — source.sha=null → unknown / no-signal', () => {
  const { verdict } = trace({
    source: stage({ ok: true, sha: null }),
    ci: stage({ ok: true, sha: 'abc1234' }),
    deploy: stage({ ok: true, sha: 'abc1234' }),
    live: stage({ ok: true, sha: 'abc1234' }),
  });
  assert.equal(verdict.layer, 'unknown');
  assert.equal(verdict.divergencePoint, 'no-signal');
});

// ---------- Rule 2: CI behind HEAD ----------
test('rule 2 — CI has older sha than source → ci / ci-not-built / high', () => {
  const { verdict, stages } = trace({
    source: stage({ ok: true, sha: 'newcommit1234', timestamp: '2026-06-01T12:00:00Z' }),
    ci: stage({
      ok: true,
      sha: 'oldcommit5678',
      timestamp: '2026-06-01T11:00:00Z',
      ageMinutes: 60,
      conclusion: 'success',
    }),
    deploy: stage({ ok: true, sha: 'oldcommit5678' }),
    live: stage({ ok: true, sha: 'oldcommit5678' }),
  });
  assertValidVerdict(verdict);
  assertValidStages(stages);
  assert.equal(verdict.layer, 'ci');
  assert.equal(verdict.divergencePoint, 'ci-not-built');
  assert.equal(verdict.confidence, 'high');
  assert.match(verdict.headline, /newcomm/i);
  assert.match(verdict.headline, /oldcomm/i);
  assert.match(verdict.recommendedNext, /re-trigger|wait/i);
});

// ---------- Rule 3: CI failed on HEAD ----------
test('rule 3 — CI succeeded:failure on HEAD → ci / ci-failed / high', () => {
  const { verdict } = trace({
    source: stage({ ok: true, sha: 'abc1234' }),
    ci: stage({
      ok: true,
      sha: 'abc1234',
      conclusion: 'failure',
      ageMinutes: 5,
      url: 'https://github.com/o/r/actions/runs/1',
    }),
    deploy: stage({ ok: false }),
    live: stage({ ok: false }),
  });
  assertValidVerdict(verdict);
  assert.equal(verdict.layer, 'ci');
  assert.equal(verdict.divergencePoint, 'ci-failed');
  assert.equal(verdict.confidence, 'high');
  assert.match(verdict.headline, /failed|conclusion/i);
  assert.match(verdict.recommendedNext, /workflow|fix/i);
});

test('rule 3 — CI cancelled on HEAD → ci-failed', () => {
  const { verdict } = trace({
    source: stage({ ok: true, sha: 'abc1234' }),
    ci: stage({ ok: true, sha: 'abc1234', conclusion: 'cancelled' }),
    deploy: stage({ ok: false }),
    live: stage({ ok: false }),
  });
  assert.equal(verdict.divergencePoint, 'ci-failed');
});

// ---------- Rule 4: CI still running ----------
test('rule 4 — CI in_progress on HEAD → ci / ci-not-built / medium', () => {
  const { verdict } = trace({
    source: stage({ ok: true, sha: 'abc1234' }),
    ci: stage({
      ok: true,
      sha: 'abc1234',
      conclusion: 'in_progress',
      ageMinutes: 3,
    }),
    deploy: stage({ ok: true, sha: 'oldsha90' }),
    live: stage({ ok: true, sha: 'oldsha90' }),
  });
  assertValidVerdict(verdict);
  assert.equal(verdict.layer, 'ci');
  assert.equal(verdict.divergencePoint, 'ci-not-built');
  assert.equal(verdict.confidence, 'medium');
  assert.match(verdict.headline, /still running/i);
});

test('rule 4 — CI conclusion=null (queued not yet started) → ci-not-built / medium', () => {
  const { verdict } = trace({
    source: stage({ ok: true, sha: 'abc1234' }),
    ci: stage({ ok: true, sha: 'abc1234', conclusion: null }),
    deploy: stage({ ok: false }),
    live: stage({ ok: false }),
  });
  assert.equal(verdict.layer, 'ci');
  assert.equal(verdict.divergencePoint, 'ci-not-built');
  assert.equal(verdict.confidence, 'medium');
});

// ---------- Rule 5: deploy behind CI ----------
test('rule 5 — CI passed on HEAD, deploy is older → deploy / deploy-behind / high', () => {
  const { verdict } = trace({
    source: stage({ ok: true, sha: 'abc1234' }),
    ci: stage({ ok: true, sha: 'abc1234', conclusion: 'success', ageMinutes: 8 }),
    deploy: stage({ ok: true, sha: 'olddeploy5678', state: 'success', ageMinutes: 120 }),
    live: stage({ ok: true, sha: 'olddeploy5678' }),
  });
  assertValidVerdict(verdict);
  assert.equal(verdict.layer, 'deploy');
  assert.equal(verdict.divergencePoint, 'deploy-behind');
  assert.equal(verdict.confidence, 'high');
  assert.match(verdict.recommendedNext, /Vercel|host|integration|retry/i);
});

// ---------- Rule 6: deploy failed ----------
test('rule 6 — deploy on HEAD but state=error → deploy / deploy-failed / high', () => {
  const { verdict } = trace({
    source: stage({ ok: true, sha: 'abc1234' }),
    ci: stage({ ok: true, sha: 'abc1234', conclusion: 'success' }),
    deploy: stage({
      ok: true,
      sha: 'abc1234',
      state: 'error',
      ageMinutes: 4,
      url: 'https://vercel.com/team/proj/deployments/x',
    }),
    live: stage({ ok: true, sha: 'oldsha9000' }),
  });
  assertValidVerdict(verdict);
  assert.equal(verdict.layer, 'deploy');
  assert.equal(verdict.divergencePoint, 'deploy-failed');
  assert.equal(verdict.confidence, 'high');
  assert.match(verdict.headline, /failed/i);
});

test('rule 6 — deploy state=failure on HEAD → deploy-failed', () => {
  const { verdict } = trace({
    source: stage({ ok: true, sha: 'abc1234' }),
    ci: stage({ ok: true, sha: 'abc1234', conclusion: 'success' }),
    deploy: stage({ ok: true, sha: 'abc1234', state: 'failure' }),
    live: stage({ ok: true, sha: 'oldsha9000' }),
  });
  assert.equal(verdict.divergencePoint, 'deploy-failed');
});

// ---------- Rule 7: live behind deploy (real-world Vercel-stuck case) ----------
test('rule 7 — live serves older sha than deploy → live / live-stale / high', () => {
  const { verdict } = trace({
    source: stage({ ok: true, sha: 'abc1234' }),
    ci: stage({ ok: true, sha: 'abc1234', conclusion: 'success', ageMinutes: 30 }),
    deploy: stage({ ok: true, sha: 'abc1234', state: 'success', ageMinutes: 20 }),
    live: stage({ ok: true, sha: 'oldlive5678', ageMinutes: 2 }),
  });
  assertValidVerdict(verdict);
  assert.equal(verdict.layer, 'live');
  assert.equal(verdict.divergencePoint, 'live-stale');
  assert.equal(verdict.confidence, 'high');
  assert.match(verdict.recommendedNext, /CDN|purge|propagation/i);
});

// ---------- Rule 8: edge cache (matching SHA but stale) ----------
test('rule 8 — live sha matches deploy but ageMinutes > 30 → edge / edge-cache / medium', () => {
  const { verdict } = trace({
    source: stage({ ok: true, sha: 'abc1234' }),
    ci: stage({ ok: true, sha: 'abc1234', conclusion: 'success' }),
    deploy: stage({ ok: true, sha: 'abc1234', state: 'success' }),
    live: stage({ ok: true, sha: 'abc1234', ageMinutes: 320 }),
  });
  assertValidVerdict(verdict);
  assert.equal(verdict.layer, 'edge');
  assert.equal(verdict.divergencePoint, 'edge-cache');
  assert.equal(verdict.confidence, 'medium');
  assert.match(verdict.headline, /age|cache/i);
});

test('rule 8 — live sha matches deploy but details mention high age header → edge-cache', () => {
  const { verdict } = trace({
    source: stage({ ok: true, sha: 'abc1234' }),
    ci: stage({ ok: true, sha: 'abc1234', conclusion: 'success' }),
    deploy: stage({ ok: true, sha: 'abc1234', state: 'success' }),
    live: stage({
      ok: true,
      sha: 'abc1234',
      ageMinutes: 5,
      details: ['age: 5400', 'x-vercel-id: cdg1::xyz'],
    }),
  });
  assert.equal(verdict.divergencePoint, 'edge-cache');
  assert.equal(verdict.layer, 'edge');
});

// ---------- Rule 9: all in sync ----------
test('rule 9 — source = ci = deploy = live → synced / in-sync / high', () => {
  const { verdict, stages } = trace({
    source: stage({ ok: true, sha: 'abc1234' }),
    ci: stage({ ok: true, sha: 'abc1234', conclusion: 'success', ageMinutes: 10 }),
    deploy: stage({ ok: true, sha: 'abc1234', state: 'success', ageMinutes: 8 }),
    live: stage({ ok: true, sha: 'abc1234', ageMinutes: 5 }),
  });
  assertValidVerdict(verdict);
  assertValidStages(stages);
  assert.equal(verdict.layer, 'synced');
  assert.equal(verdict.divergencePoint, 'in-sync');
  assert.equal(verdict.confidence, 'high');
  // All downstream stages report in-sync vs predecessor.
  assert.equal(stages[1].status, 'in-sync');
  assert.equal(stages[2].status, 'in-sync');
  assert.equal(stages[3].status, 'in-sync');
});

test('rule 9 — full-length vs short shas still match', () => {
  const { verdict } = trace({
    source: stage({ ok: true, sha: 'abc1234567890abcdef1234567890abcdef12345' }),
    ci: stage({ ok: true, sha: 'abc1234', conclusion: 'success' }),
    deploy: stage({ ok: true, sha: 'abc1234', state: 'success' }),
    live: stage({ ok: true, sha: 'abc1234' }),
  });
  assert.equal(verdict.divergencePoint, 'in-sync');
});

// ---------- Rule 10: fallback ----------
test('rule 10 — fallback on incomplete signal → unknown / no-signal / low', () => {
  const { verdict } = trace({
    source: stage({ ok: true, sha: 'abc1234' }),
    ci: stage({ ok: false, error: 'no runs found' }),
    deploy: stage({ ok: false, error: 'no deploys found' }),
    live: stage({ ok: false, error: 'http 503' }),
  });
  assertValidVerdict(verdict);
  assert.equal(verdict.layer, 'unknown');
  assert.equal(verdict.confidence, 'low');
  assert.equal(verdict.divergencePoint, 'no-signal');
  assert.match(verdict.rationale, /source abc/i);
});

// ---------- stages array shape ----------
test('stages array — all four stages present with correct names + comparedTo', () => {
  const { stages } = trace({
    source: stage({ ok: true, sha: 'aaa1111' }),
    ci: stage({ ok: true, sha: 'aaa1111', conclusion: 'success' }),
    deploy: stage({ ok: true, sha: 'aaa1111', state: 'success' }),
    live: stage({ ok: true, sha: 'aaa1111' }),
  });
  assertValidStages(stages);
});

test('stages array — behind status when ci is older than source', () => {
  const { stages } = trace({
    source: stage({ ok: true, sha: 'newer1234', timestamp: '2026-06-01T12:00:00Z' }),
    ci: stage({ ok: true, sha: 'older5678', timestamp: '2026-06-01T10:00:00Z', conclusion: 'success' }),
    deploy: stage({ ok: true, sha: 'older5678' }),
    live: stage({ ok: true, sha: 'older5678' }),
  });
  assert.equal(stages[0].status, 'in-sync');
  assert.equal(stages[1].status, 'behind');
  assert.equal(stages[2].status, 'in-sync'); // ci == deploy
  assert.equal(stages[3].status, 'in-sync'); // deploy == live
});

test('stages array — unknown status when predecessor sha missing', () => {
  const { stages } = trace({
    source: stage({ ok: false, sha: null }),
    ci: stage({ ok: true, sha: 'abc1234', conclusion: 'success' }),
    deploy: stage({ ok: true, sha: 'abc1234' }),
    live: stage({ ok: true, sha: 'abc1234' }),
  });
  assert.equal(stages[1].status, 'unknown');
});

test('stages array — state pass-through preserves raw fields', () => {
  const { stages } = trace({
    source: stage({ ok: true, sha: 'abc1234' }),
    ci: stage({
      ok: true,
      sha: 'abc1234',
      conclusion: 'success',
      url: 'https://github.com/o/r/actions/runs/77',
      ageMinutes: 12,
    }),
    deploy: stage({ ok: true, sha: 'abc1234', state: 'success', ageMinutes: 8 }),
    live: stage({ ok: true, sha: 'abc1234', ageMinutes: 4, details: ['x-vercel-id: abc'] }),
  });
  assert.equal(stages[1].state.url, 'https://github.com/o/r/actions/runs/77');
  assert.equal(stages[1].state.conclusion, 'success');
  assert.equal(stages[2].state.state, 'success');
  assert.deepEqual(stages[3].state.details, ['x-vercel-id: abc']);
});

// ---------- renderTraceMarkdown ----------
test('renderTraceMarkdown — contains headline, divergence point, rationale, stage table, recommendedNext', () => {
  const { verdict, stages } = trace({
    source: stage({ ok: true, sha: 'abc1234' }),
    ci: stage({ ok: true, sha: 'abc1234', conclusion: 'success', ageMinutes: 10 }),
    deploy: stage({ ok: true, sha: 'oldsha8888', state: 'success', ageMinutes: 60 }),
    live: stage({ ok: true, sha: 'oldsha8888' }),
  });
  const md = renderTraceMarkdown(verdict, stages);
  assert.equal(typeof md, 'string');
  assert.ok(md.includes(verdict.headline), 'markdown contains headline');
  assert.match(md, /Divergence point/i);
  assert.match(md, /Confidence/i);
  assert.ok(md.includes(verdict.rationale), 'markdown contains rationale paragraph');
  assert.ok(md.includes(verdict.recommendedNext), 'markdown contains recommendedNext');
  // Table header + rows for all four stages.
  assert.match(md, /\| Stage \| SHA \| Age \| Status \| Conclusion/);
  assert.match(md, /\| source \|/);
  assert.match(md, /\| ci \|/);
  assert.match(md, /\| deploy \|/);
  assert.match(md, /\| live \|/);
});

test('renderTraceMarkdown — handles empty / missing stages gracefully', () => {
  const md = renderTraceMarkdown(
    {
      layer: 'unknown',
      confidence: 'low',
      headline: 'Test verdict',
      rationale: 'r',
      recommendedNext: 'n',
      divergencePoint: 'no-signal',
    },
    []
  );
  assert.ok(md.includes('Test verdict'));
  assert.match(md, /Divergence point/);
});

test('renderTraceMarkdown — null inputs do not throw', () => {
  const md = renderTraceMarkdown(null, null);
  assert.equal(typeof md, 'string');
  assert.ok(md.length > 0);
});

// ---------- rule ordering / overlap guards ----------
test('rule ordering — CI behind source wins over deploy/live diagnostics', () => {
  // CI behind source AND live behind deploy. Rule 2 fires first.
  const { verdict } = trace({
    source: stage({ ok: true, sha: 'newcommit', timestamp: '2026-06-01T12:00:00Z' }),
    ci: stage({ ok: true, sha: 'oldcommit', conclusion: 'success', timestamp: '2026-06-01T11:00:00Z' }),
    deploy: stage({ ok: true, sha: 'oldcommit', state: 'success' }),
    live: stage({ ok: true, sha: 'evenolder', ageMinutes: 200 }),
  });
  assert.equal(verdict.divergencePoint, 'ci-not-built');
});

test('rule ordering — CI failed wins over downstream signals', () => {
  const { verdict } = trace({
    source: stage({ ok: true, sha: 'abc1234' }),
    ci: stage({ ok: true, sha: 'abc1234', conclusion: 'failure' }),
    deploy: stage({ ok: true, sha: 'olddeploy', state: 'success' }),
    live: stage({ ok: true, sha: 'olddeploy', ageMinutes: 9999 }),
  });
  assert.equal(verdict.divergencePoint, 'ci-failed');
});

// ---------- input robustness ----------
test('trace handles totally missing input object', () => {
  const { verdict, stages } = trace(undefined);
  assertValidVerdict(verdict);
  assertValidStages(stages);
  assert.equal(verdict.divergencePoint, 'no-signal');
});

test('trace handles partial input object', () => {
  const { verdict } = trace({ source: stage({ ok: true, sha: 'abc1234' }) });
  // Source ok, everything else missing → fallback no-signal.
  assertValidVerdict(verdict);
  assert.equal(verdict.divergencePoint, 'no-signal');
});

test('trace handles non-object input gracefully', () => {
  const { verdict, stages } = trace('not an object');
  assertValidVerdict(verdict);
  assertValidStages(stages);
});
